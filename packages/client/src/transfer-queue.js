const TRANSFER_QUEUE_KEY = "orchard.transferQueue.v1";
const LEGACY_TRANSFER_QUEUE_KEY = "sanctumshare.transferQueue.v1";
export const DEFAULT_GLOBAL_BYTES_PER_SECOND = 750 * 1024;
export const DEFAULT_PEER_BYTES_PER_SECOND = 500 * 1024;
const MAX_RANDOM_SUFFIX = 1e9;
const MAX_SPEED_SAMPLES = 8;

export const TRANSFER_STATES = Object.freeze({
  QUEUED: "queued",
  CONNECTING: "connecting",
  DIRECT: "direct",
  RELAY: "relay",
  REQUESTING: "requesting",
  APPROVED: "approved",
  DOWNLOADING: "downloading",
  RESUMED: "resumed",
  PAUSED: "paused",
  STALLED: "stalled",
  THROTTLED: "throttled",
  COMPLETED: "completed",
  FAILED: "failed",
  REJECTED: "rejected",
});

function now() {
  return Date.now();
}

function generateTransferId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `tx-${crypto.randomUUID()}`;
  }
  return `tx-${now()}-${Math.floor(Math.random() * MAX_RANDOM_SUFFIX).toString(36)}`;
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export class TransferQueue {
  constructor(options = {}) {
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
    this.globalBytesPerSecond = Number.isFinite(options.globalBytesPerSecond) ? options.globalBytesPerSecond : DEFAULT_GLOBAL_BYTES_PER_SECOND;
    this.peerBytesPerSecond = Number.isFinite(options.peerBytesPerSecond) ? options.peerBytesPerSecond : DEFAULT_PEER_BYTES_PER_SECOND;
    this.maxActive = Number.isInteger(options.maxActive) ? options.maxActive : 1;
    this.items = [];
    this.listeners = new Set();
    // Transient sliding-window speed samples: Map<id, [{loaded, t}]>
    // Not persisted — speed resets on restart which is intentional.
    this._speedSamples = new Map();
    this.hydrate();
  }

  hydrate() {
    if (typeof localStorage === "undefined") return;
    const rawCurrent = localStorage.getItem(TRANSFER_QUEUE_KEY);
    const rawLegacy = rawCurrent ? null : localStorage.getItem(LEGACY_TRANSFER_QUEUE_KEY);
    const raw = rawCurrent || rawLegacy;
    if (!raw) return;
    const parsed = safeParse(raw, []);
    if (!Array.isArray(parsed)) return;
    this.items = parsed.map((item) => ({
      ...item,
      status: item.status === TRANSFER_STATES.DOWNLOADING ? TRANSFER_STATES.PAUSED : item.status,
      loaded: Number(item.loaded || 0),
      total: Number(item.total || 0),
      resumeOffset: Number(item.resumeOffset || 0),
      retries: Number(item.retries || 0),
      priority: Number(item.priority ?? item.createdAt ?? now()),
      createdAt: Number(item.createdAt || now()),
      updatedAt: Number(item.updatedAt || now()),
    }));
    if (rawLegacy) {
      try {
        localStorage.setItem(TRANSFER_QUEUE_KEY, JSON.stringify(this.items));
      } catch {
        // ignore migration write failure and continue with in-memory queue
      }
    }
    this.reindexQueuedPriorities();
  }

  persist() {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(TRANSFER_QUEUE_KEY, JSON.stringify(this.items));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.items);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.persist();
    for (const listener of this.listeners) listener(this.items);
  }

  list() {
    return this.items;
  }

  activeCount() {
    return this.items.filter((item) =>
      item.status === TRANSFER_STATES.REQUESTING ||
      item.status === TRANSFER_STATES.APPROVED ||
      item.status === TRANSFER_STATES.CONNECTING ||
      item.status === TRANSFER_STATES.DIRECT ||
      item.status === TRANSFER_STATES.DOWNLOADING ||
      item.status === TRANSFER_STATES.RELAY
    ).length;
  }

  nextQueuedPriority() {
    return this.items.reduce((max, item) => {
      const priority = Number(item.priority || 0);
      return Number.isFinite(priority) ? Math.max(max, priority) : max;
    }, 0) + 1;
  }

  reindexQueuedPriorities() {
    const queued = this.items
      .filter((item) => item.status === TRANSFER_STATES.QUEUED)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
    queued.forEach((item, index) => {
      item.priority = index + 1;
    });
  }

  enqueue(payload) {
    const id = payload.id || generateTransferId();
    if (this.items.some((item) => item.id === id)) return id;
    this.items.push({
      id,
      ownerId: payload.ownerId,
      ownerUsername: payload.ownerUsername || "",
      filePath: payload.filePath,
      fileName: payload.fileName,
      ownerHost: payload.ownerHost || null,
      ownerPort: payload.ownerPort || null,
      relayEligible: payload.relayEligible !== false,
      status: TRANSFER_STATES.QUEUED,
      loaded: 0,
      total: 0,
      resumeOffset: 0,
      retries: 0,
      stalledAt: null,
      error: null,
      priority: this.nextQueuedPriority(),
      createdAt: now(),
      updatedAt: now(),
    });
    this.notify();
    return id;
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: now() });
    this.notify();
    return item;
  }

  setStatus(id, status, extra = {}) {
    return this.update(id, { status, ...extra });
  }

  setProgress(id, loaded, total) {
    const item = this.get(id);
    if (!item) return null;

    const t = now();

    // Update sliding-window speed samples
    let samples = this._speedSamples.get(id);
    if (!samples) {
      samples = [];
      this._speedSamples.set(id, samples);
    }
    samples.push({ loaded, t });
    if (samples.length > MAX_SPEED_SAMPLES) samples.shift();

    // Compute smoothed speed from oldest to newest sample in the window
    let speedBytesPerSec = 0;
    let etaSec = null;
    if (samples.length >= 2) {
      const oldest = samples[0];
      const newest = samples[samples.length - 1];
      const elapsed = newest.t - oldest.t;
      const bytes = newest.loaded - oldest.loaded;
      if (elapsed > 0 && bytes >= 0) {
        speedBytesPerSec = (bytes / elapsed) * 1000; // bytes per second
        const remaining = (total || 0) - loaded;
        if (speedBytesPerSec > 0 && remaining > 0) {
          etaSec = Math.ceil(remaining / speedBytesPerSec);
        }
      }
    }

    return this.update(id, { loaded, total: total || 0, stalledAt: null, speedBytesPerSec, etaSec });
  }

  pause(id) {
    const item = this.get(id);
    if (!item) return null;
    if (
      item.status !== TRANSFER_STATES.DOWNLOADING &&
      item.status !== TRANSFER_STATES.REQUESTING &&
      item.status !== TRANSFER_STATES.RELAY &&
      item.status !== TRANSFER_STATES.STALLED
    ) {
      return item;
    }
    this._speedSamples.delete(id);
    return this.setStatus(id, TRANSFER_STATES.PAUSED, { stalledAt: null, speedBytesPerSec: 0, etaSec: null });
  }

  /**
   * Record the current loaded byte offset so a future resume can use
   * an HTTP Range header to continue from where we left off.
   */
  markInterrupted(id) {
    const item = this.get(id);
    if (!item) return null;
    this._speedSamples.delete(id);
    // Persist loaded as resumeOffset before marking paused
    return this.update(id, {
      status: TRANSFER_STATES.PAUSED,
      resumeOffset: item.loaded,
      stalledAt: null,
      speedBytesPerSec: 0,
      etaSec: null,
    });
  }

  resume(id) {
    const item = this.get(id);
    if (!item) return null;
    if (
      item.status !== TRANSFER_STATES.PAUSED &&
      item.status !== TRANSFER_STATES.FAILED &&
      item.status !== TRANSFER_STATES.STALLED
    ) return item;
    // Keep resumeOffset so the download handler can issue a Range request.
    return this.setStatus(id, TRANSFER_STATES.QUEUED, { error: null, stalledAt: null });
  }

  reject(id, message = "Rejected by peer") {
    return this.setStatus(id, TRANSFER_STATES.REJECTED, { error: message });
  }

  fail(id, message) {
    const item = this.get(id);
    if (!item) return null;
    if (item.status === TRANSFER_STATES.PAUSED) {
      return item;
    }
    this._speedSamples.delete(id);
    if ((item.retries || 0) < this.maxRetries) {
      return this.setStatus(id, TRANSFER_STATES.QUEUED, {
        retries: (item.retries || 0) + 1,
        error: message || "Retrying",
        stalledAt: null,
        speedBytesPerSec: 0,
        etaSec: null,
      });
    }
    return this.setStatus(id, TRANSFER_STATES.FAILED, { error: message || "Failed", speedBytesPerSec: 0, etaSec: null });
  }

  complete(id) {
    this._speedSamples.delete(id);
    return this.setStatus(id, TRANSFER_STATES.COMPLETED, { error: null, stalledAt: null, speedBytesPerSec: 0, etaSec: null });
  }

  markStalled(id, message = "Transfer appears stalled") {
    const item = this.get(id);
    if (!item) return null;
    if (
      item.status !== TRANSFER_STATES.DOWNLOADING &&
      item.status !== TRANSFER_STATES.REQUESTING &&
      item.status !== TRANSFER_STATES.RELAY
    ) {
      return item;
    }
    return this.setStatus(id, TRANSFER_STATES.STALLED, { error: message, stalledAt: now() });
  }

  next() {
    if (this.activeCount() >= this.maxActive) return null;
    const queued = this.items.filter((item) => item.status === TRANSFER_STATES.QUEUED);
    if (!queued.length) return null;

    const perPeerCount = new Map();
    for (const item of this.items) {
      if (
        item.status === TRANSFER_STATES.REQUESTING ||
        item.status === TRANSFER_STATES.APPROVED ||
        item.status === TRANSFER_STATES.CONNECTING ||
        item.status === TRANSFER_STATES.DIRECT ||
        item.status === TRANSFER_STATES.DOWNLOADING ||
        item.status === TRANSFER_STATES.RELAY
      ) {
        perPeerCount.set(item.ownerId, (perPeerCount.get(item.ownerId) || 0) + 1);
      }
    }
    queued.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const ac = perPeerCount.get(a.ownerId) || 0;
      const bc = perPeerCount.get(b.ownerId) || 0;
      if (ac !== bc) return ac - bc;
      return a.createdAt - b.createdAt;
    });
    return queued[0];
  }

  moveQueued(id, direction) {
    const queued = this.items
      .filter((item) => item.status === TRANSFER_STATES.QUEUED)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
    const index = queued.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= queued.length) return false;
    const [current] = queued.splice(index, 1);
    queued.splice(targetIndex, 0, current);
    const updatedAt = now();
    queued.forEach((item, orderedIndex) => {
      item.priority = orderedIndex + 1;
      item.updatedAt = updatedAt;
    });
    this.notify();
    return true;
  }

  moveQueuedTo(id, targetId) {
    if (!id || !targetId || id === targetId) return false;
    const queued = this.items
      .filter((item) => item.status === TRANSFER_STATES.QUEUED)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
    const sourceIndex = queued.findIndex((item) => item.id === id);
    const rawTargetIndex = queued.findIndex((item) => item.id === targetId);
    if (sourceIndex < 0 || rawTargetIndex < 0) return false;
    const [source] = queued.splice(sourceIndex, 1);
    const targetIndex = sourceIndex < rawTargetIndex ? rawTargetIndex - 1 : rawTargetIndex;
    queued.splice(targetIndex, 0, source);
    const updatedAt = now();
    queued.forEach((item, orderedIndex) => {
      item.priority = orderedIndex + 1;
      item.updatedAt = updatedAt;
    });
    this.notify();
    return true;
  }
}
