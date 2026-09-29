import React, { useState, useEffect, useRef, useMemo } from "react";
import { io } from "socket.io-client";
import { config } from "./config.js";
import { HEARTBEAT, EVENTS } from "@shared/protocol.js";
import { createLifecycleLog } from "@shared/lifecycle-log.js";
import {
  TransferQueue,
  TRANSFER_STATES,
  DEFAULT_GLOBAL_BYTES_PER_SECOND,
  DEFAULT_PEER_BYTES_PER_SECOND,
} from "./transfer-queue.js";
import { getTrust, setTrust } from "./trust-policy.js";
import { AdminPanel } from "./components/AdminPanel.jsx";
import { MessagingDrawer } from "./components/MessagingDrawer.jsx";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { ConfirmationDialog } from "./components/ConfirmationDialog.jsx";
import { ProgressBar } from "./components/ProgressBar.jsx";
import { FileTree } from "./components/FileTree.jsx";
import { SettingsPage, loadBandwidthSettings } from "./components/SettingsPage.jsx";
import { TransferQueuePanel } from "./components/TransferQueuePanel.jsx";
import { WishlistPanel } from "./components/WishlistPanel.jsx";
import { SearchResultsPanel } from "./components/SearchResultsPanel.jsx";
import "./index.css";

function getOrCreateClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const legacyExisting = localStorage.getItem(LEGACY_CLIENT_ID_KEY);
  if (legacyExisting) {
    localStorage.setItem(CLIENT_ID_KEY, legacyExisting);
    return legacyExisting;
  }

  const generated = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(CLIENT_ID_KEY, generated);
  return generated;
}

const CLIENT_VERSION = "client-v1";
const CONNECTION_STATES = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
});
const RECONNECT_BACKOFF = Object.freeze({
  BASE_MS: 1000,
  MAX_MS: 30000,
  STABLE_RESET_MS: 30000,
});
/** Timeout for attempting a direct HTTP download before falling back to broker relay. */
const DIRECT_DOWNLOAD_TIMEOUT_MS = 8000;
/** Size of each chunk sent during broker-relay file streaming. */
const RELAY_SERVE_CHUNK_SIZE = 256 * 1024;

const NAT_STRATEGY = Object.freeze({
  DIRECT: "direct",
  UPNP: "upnp-assist",
  RELAY: "relay-fallback",
});
const THROTTLE_CHUNK_INTERVAL_MS = 120;
const MIN_THROTTLE_CHUNK_BYTES = 32 * 1024;
const MS_PER_SECOND = 1000;
const UNKNOWN_DEVICE_LABEL = "unknown-device";
const CLIENT_ID_KEY = "orchard.clientId";
const LEGACY_CLIENT_ID_KEY = "sanctumshare.clientId";
const ONBOARDING_DONE_KEY = "orchard.onboarding.v0.done";
const LEGACY_ONBOARDING_DONE_KEY = "sanctumshare.onboarding.v0.done";
const DEFAULT_INVITE_MAX_USES = 5;
const DEFAULT_INVITE_EXPIRES_HOURS = 48;
const TRANSFER_STALL_TIMEOUT_MS = 30_000;
const TRANSFER_STALL_SWEEP_MS = 5_000;
const WISHLIST_STORAGE_KEY = "orchard.wishlist.v1";
const LEGACY_WISHLIST_STORAGE_KEY = "sanctumshare.wishlist.v1";
const LIFECYCLE_DEBUG_KEY = "orchard.lifecycleDebug";
const LEGACY_LIFECYCLE_DEBUG_KEY = "sanctumshare.lifecycleDebug";
const CONNECTION_STATE_EVENT = "orchard:connection-state";
const LEGACY_CONNECTION_STATE_EVENT = "sanctumshare:connection-state";
const LIFECYCLE_DEBUG_EVENT = "orchard:lifecycle-debug";
const LEGACY_LIFECYCLE_DEBUG_EVENT = "sanctumshare:lifecycle-debug";
const ROOM_HISTORY_LIMIT = 120;

function readStorageWithLegacy(primaryKey, legacyKey) {
  if (typeof localStorage === "undefined") return null;
  const primary = localStorage.getItem(primaryKey);
  if (primary !== null) return primary;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    try {
      localStorage.setItem(primaryKey, legacy);
    } catch {
      // ignore write failure and still return legacy value
    }
  }
  return legacy;
}

function extractFileName(filePath = "") {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function resolveDeviceId(primary, fallback = null) {
  const val = (primary || fallback || "").toString().trim();
  return val || UNKNOWN_DEVICE_LABEL;
}

function loadWishlist() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = readStorageWithLegacy(WISHLIST_STORAGE_KEY, LEGACY_WISHLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistWishlist(items) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(items.slice(0, 20)));
}

function collectFileNames(tree, acc = []) {
  if (!Array.isArray(tree)) return acc;
  for (const entry of tree) {
    if (!entry) continue;
    if (entry.type === "directory") {
      collectFileNames(entry.children || [], acc);
    } else if (typeof entry.name === "string") {
      acc.push(entry.name.toLowerCase());
    }
  }
  return acc;
}

/**
 * Flatten a file tree into a list of { name, path, size, relativePath } entries.
 * Includes each file's full folder path for display in search results.
 */
function flattenFileTree(tree, folderPath = []) {
  const results = [];
  if (!Array.isArray(tree)) return results;
  for (const entry of tree) {
    if (!entry) continue;
    if (entry.type === "directory") {
      results.push(...flattenFileTree(entry.children || [], [...folderPath, entry.name]));
    } else if (entry.type === "file") {
      results.push({
        name: entry.name,
        path: entry.path || entry.fileRef || entry.id,
        size: entry.size || 0,
        relativePath: [...folderPath, entry.name].join("/"),
      });
    }
  }
  return results;
}

function connectivityHint(status = "") {
  if (status.includes("direct:failed")) return "Direct path failed. Check firewall/router settings or rely on relay.";
  if (status.includes("relay:failed")) return "Relay failed. Ensure both peers stay online and broker has capacity.";
  if (status.includes("relay:start")) return "Relay is active; direct path was unavailable.";
  if (status.includes("direct:success")) return "Direct transfer succeeded.";
  if (status.includes("stalled")) return "Transfer stalled. Resume to retry with fresh connectivity.";
  return "Connectivity event recorded.";
}

// Helper to save a Blob in the browser (fallback when not in Electron)
function saveBlobInBrowser(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "light");
  const [token, setToken] = useState(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [socket, setSocket] = useState(null);
  const [onlineClients, setOnlineClients] = useState([]);
  const [onlinePeers, setOnlinePeers] = useState([]);
  const [myFiles, setMyFiles] = useState([]);
  const [downloadMsg, setDownloadMsg] = useState("");
  const [authError, setAuthError] = useState("");
  const [downloadRequest, setDownloadRequest] = useState(null);
  const [sendRequest, setSendRequest] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [transferQueueItems, setTransferQueueItems] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [buddies, setBuddies] = useState([]);
  const [buddyRequests, setBuddyRequests] = useState([]);
  const [showBuddyDialog, setShowBuddyDialog] = useState(false);
  const [buddyUsername, setBuddyUsername] = useState("");
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [userSearchError, setUserSearchError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [sharedFolderPath, setSharedFolderPath] = useState("");
  const [dragOver, setDragOver] = useState(null);
  const [activeChatPeer, setActiveChatPeer] = useState(null);
  const [spaces, setSpaces] = useState([]);
  const [activeSpaceId, setActiveSpaceId] = useState(null);
  const [activeSpace, setActiveSpace] = useState(null);
  const [spaceRoomMessages, setSpaceRoomMessages] = useState([]);
  const [spaceRoomBody, setSpaceRoomBody] = useState("");
  const [spaceInvites, setSpaceInvites] = useState([]);
  const [spaceJoinRequests, setSpaceJoinRequests] = useState([]);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [joinInviteCode, setJoinInviteCode] = useState("");
  const [inviteCodeToCreate, setInviteCodeToCreate] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [preflight, setPreflight] = useState({ broker: false, nat: "unknown", relayEligible: false, desktop: false });
  const [connectivityInfo, setConnectivityInfo] = useState(null);
  const [transferDiagnostics, setTransferDiagnostics] = useState([]);
  const [wishlistQuery, setWishlistQuery] = useState("");
  const [wishlistItems, setWishlistItems] = useState([]);
  const [wishlistMatches, setWishlistMatches] = useState([]);
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.DISCONNECTED);
  const [connectionSessionId, setConnectionSessionId] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [bandwidthSettings, setBandwidthSettings] = useState(() => {
    const stored = loadBandwidthSettings();
    return {
      globalBytesPerSecond: stored?.globalBytesPerSecond ?? DEFAULT_GLOBAL_BYTES_PER_SECOND,
      peerBytesPerSecond: stored?.peerBytesPerSecond ?? DEFAULT_PEER_BYTES_PER_SECOND,
      maxActive: stored?.maxActive ?? 1,
    };
  });
  const clientIdRef = useRef(null);
  const socketRef = useRef(null);
  const queueRef = useRef(null);
  const activeDownloadRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const stableConnectionTimerRef = useRef(null);
  const manualDisconnectRef = useRef(false);
  const connectionSessionIdRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const activeRelayRef = useRef(null);
  const joinedRoomRef = useRef(null);
  const activeChatPeerRef = useRef(null);
  const activeSpaceIdRef = useRef(null);
  const lifecycleDebugEnabledRef = useRef(config.lifecycleDebug || readStorageWithLegacy(LIFECYCLE_DEBUG_KEY, LEGACY_LIFECYCLE_DEBUG_KEY) === "true");
  const wishlistMatchCountsRef = useRef({});

  const isElectron = typeof window !== "undefined" && !!window.electronAPI;

  /**
   * Flat list of matching files from all online peers — used for the global search
   * results panel. Each result includes peer info and the file's relative path.
   * Max 200 results to avoid overwhelming the UI.
   */
  const globalSearchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query || onlineClients.length === 0) return [];
    const results = [];
    for (const client of onlineClients) {
      if (!client?.user?.id || !Array.isArray(client.files)) continue;
      const flat = flattenFileTree(client.files);
      for (const file of flat) {
        if (file.name.toLowerCase().includes(query) || file.relativePath.toLowerCase().includes(query)) {
          results.push({ peer: client.user, file });
          if (results.length >= 200) return results;
        }
      }
    }
    return results;
  }, [searchQuery, onlineClients]);
  const totalUnreadMessages = useMemo(
    () => Object.values(unreadCounts).reduce((sum, count) => sum + Number(count || 0), 0),
    [unreadCounts]
  );
  const pendingTransferRequests = (downloadRequest ? 1 : 0) + (sendRequest ? 1 : 0);
  const pendingActionCount = buddyRequests.length + spaceJoinRequests.length + pendingTransferRequests;
  const totalNotificationCount = pendingActionCount + totalUnreadMessages;

  const refreshSpaces = async () => {
    if (!token) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const items = await r.json();
      setSpaces(items);
      if (items.length === 0) {
        setActiveSpaceId(null);
      } else if (!activeSpaceId || !items.some((s) => s.id === activeSpaceId)) {
        setActiveSpaceId(items[0].id);
      }
    } catch (err) {
      console.error("Failed to refresh spaces:", err);
    }
  };

  const refreshActiveSpace = async (spaceIdArg) => {
    const spaceId = spaceIdArg || activeSpaceId;
    if (!token || !spaceId) {
      setActiveSpace(null);
      setSpaceInvites([]);
      setSpaceJoinRequests([]);
      return;
    }
    try {
      const [spaceRes, invitesRes, requestsRes] = await Promise.all([
        fetch(`${config.serverUrl}/spaces/${spaceId}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${config.serverUrl}/spaces/${spaceId}/invites`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${config.serverUrl}/spaces/${spaceId}/requests`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (spaceRes.ok) setActiveSpace(await spaceRes.json());
      if (invitesRes.ok) setSpaceInvites(await invitesRes.json());
      else setSpaceInvites([]);
      if (requestsRes.ok) setSpaceJoinRequests(await requestsRes.json());
      else setSpaceJoinRequests([]);
    } catch (err) {
      console.error("Failed to refresh active space:", err);
    }
  };

  const runPreflight = async (sock) => {
    const next = { broker: !!sock?.connected, nat: "unknown", relayEligible: false, desktop: isElectron };
    if (isElectron && window.electronAPI?.getNatResult) {
      try {
        const nat = await window.electronAPI.getNatResult();
        next.nat = nat?.strategy || "relay-fallback";
        next.relayEligible = nat?.relayEligible !== false;
      } catch {
        next.nat = "unknown";
      }
    }
    setPreflight(next);
  };

  const emitConnectionStateEvent = (detail) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CONNECTION_STATE_EVENT, { detail }));
    window.dispatchEvent(new CustomEvent(LEGACY_CONNECTION_STATE_EVENT, { detail }));
  };

  const logLifecycleDebug = (event, state, extra = {}, level = "log") => {
    if (!lifecycleDebugEnabledRef.current) return;
    const payload = createLifecycleLog({
      clientId: clientIdRef.current,
      sessionId: connectionSessionIdRef.current,
      event,
      state,
      ...extra,
    });
    const logMethod = level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    logMethod("[LifecycleDebug]", payload);
  };

  const transitionConnectionState = (nextState, meta = {}) => {
    setConnectionState((previousState) => {
      if (previousState === nextState) return previousState;
      const detail = createLifecycleLog({
        clientId: clientIdRef.current,
        sessionId: connectionSessionIdRef.current,
        event: "connection:state-change",
        state: nextState,
        errorCode: meta.errorCode ?? null,
        fromState: previousState,
        toState: nextState,
        ...meta,
      });
      console.log("[ConnectionState]", detail);
      emitConnectionStateEvent(detail);
      return nextState;
    });
  };

  const clearReconnectTimer = () => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };

  const clearStableConnectionTimer = () => {
    if (!stableConnectionTimerRef.current) return;
    clearTimeout(stableConnectionTimerRef.current);
    stableConnectionTimerRef.current = null;
  };

  const clearHeartbeatTimer = () => {
    if (!heartbeatTimerRef.current) return;
    clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
  };

  const getNatStrategy = (item) => {
    if (item?.ownerHost && item?.ownerPort) return NAT_STRATEGY.DIRECT;
    if (item?.relayEligible) return NAT_STRATEGY.RELAY;
    return NAT_STRATEGY.UPNP;
  };

  const processQueue = async () => {
    if (!socketRef.current?.connected || !queueRef.current) return;
    if (activeDownloadRef.current) return;
    const next = queueRef.current.next();
    if (!next) return;
    queueRef.current.setStatus(next.id, TRANSFER_STATES.REQUESTING);
    setDownloadMsg(`Queue: requesting ${next.fileName}`);
    socketRef.current.emit(EVENTS.REQUEST_DOWNLOAD, {
      fromUserId: next.ownerId,
      filePath: next.filePath,
      fileName: next.fileName,
      transferId: next.id,
    });
  };

  const resetPresenceState = () => {
    setConnectionSessionId(null);
    connectionSessionIdRef.current = null;
    setOnlineClients([]);
    setOnlinePeers([]);
  };

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = totalNotificationCount > 0 ? `(${totalNotificationCount}) Orchard` : "Orchard";
    }
    if (isElectron && window.electronAPI?.setAppBadgeCount) {
      window.electronAPI.setAppBadgeCount(totalNotificationCount).catch(() => {});
    }
  }, [isElectron, totalNotificationCount]);

  // Auto-restore JWT token from OS keychain / safeStorage on Electron startup (Item 4)
  useEffect(() => {
    const isElectronEnv = typeof window !== "undefined" && !!window.electronAPI?.getStoredToken;
    if (!isElectronEnv) { setTokenLoading(false); return; }
    window.electronAPI.getStoredToken().then((stored) => {
      if (stored) {
        setToken(stored);
      }
      setTokenLoading(false);
    }).catch(() => setTokenLoading(false));
  }, []);

  useEffect(() => {
    const initial = loadWishlist();
    setWishlistItems(initial);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = () => {
      lifecycleDebugEnabledRef.current = config.lifecycleDebug || readStorageWithLegacy(LIFECYCLE_DEBUG_KEY, LEGACY_LIFECYCLE_DEBUG_KEY) === "true";
    };
    const onToggle = (event) => {
      const enabled = !!event?.detail?.enabled;
      localStorage.setItem(LIFECYCLE_DEBUG_KEY, enabled ? "true" : "false");
      lifecycleDebugEnabledRef.current = enabled;
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(LIFECYCLE_DEBUG_EVENT, onToggle);
    window.addEventListener(LEGACY_LIFECYCLE_DEBUG_EVENT, onToggle);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LIFECYCLE_DEBUG_EVENT, onToggle);
      window.removeEventListener(LEGACY_LIFECYCLE_DEBUG_EVENT, onToggle);
    };
  }, []);

  useEffect(() => {
    logLifecycleDebug("app:mounted", connectionState, { reason: "ui-mounted" });
  }, []);

  useEffect(() => {
    logLifecycleDebug("connection:session", connectionState, { reason: "session-updated", sessionId: connectionSessionId });
  }, [connectionSessionId, connectionState]);

  // Fetch buddy list and pending requests when user logs in
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const response = await fetch(`${config.serverUrl}/buddies`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.ok) setBuddies(await response.json());
      } catch (err) {
        console.error("Failed to fetch buddies:", err);
      }
      try {
        const reqRes = await fetch(`${config.serverUrl}/buddies/requests`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (reqRes.ok) setBuddyRequests(await reqRes.json());
      } catch (err) {
        console.error("Failed to fetch buddy requests:", err);
      }
      await refreshSpaces();
      const onboardingDone = readStorageWithLegacy(ONBOARDING_DONE_KEY, LEGACY_ONBOARDING_DONE_KEY) === "true";
      if (!onboardingDone) {
        setShowOnboarding(true);
        setOnboardingStep(0);
      }
    })();
  }, [token]);

  useEffect(() => {
    if (!wishlistItems.length) {
      wishlistMatchCountsRef.current = {};
      setWishlistMatches([]);
      return;
    }
    const peerCatalog = onlineClients
      .filter((client) => client?.user?.id && Array.isArray(client.files))
      .map((client) => ({
        userId: client.user.id,
        username: client.user.username,
        names: collectFileNames(client.files || []),
      }));
    const nextMatches = wishlistItems.map((query) => {
      const lower = query.toLowerCase();
      const peers = peerCatalog
        .filter((peer) => peer.names.some((name) => name.includes(lower)))
        .map((peer) => ({ userId: peer.userId, username: peer.username }));
      return { query, peers, count: peers.length };
    });
    setWishlistMatches(nextMatches);

    for (const item of nextMatches) {
      const prev = wishlistMatchCountsRef.current[item.query] || 0;
      if (item.count > prev && item.count > 0) {
        setDownloadMsg(`Wishlist match: "${item.query}" now available from ${item.count} peer(s)`);
        setTimeout(() => setDownloadMsg(""), 3500);
      }
      wishlistMatchCountsRef.current[item.query] = item.count;
    }
  }, [onlineClients, wishlistItems]);

  useEffect(() => {
    const id = setInterval(() => {
      const queue = queueRef.current;
      if (!queue) return;
      const nowMs = Date.now();
      const active = queue.list().filter((item) =>
        item.status === TRANSFER_STATES.REQUESTING ||
        item.status === TRANSFER_STATES.DOWNLOADING ||
        item.status === TRANSFER_STATES.RELAY
      );
      for (const item of active) {
        if (nowMs - (item.updatedAt || item.createdAt || 0) >= TRANSFER_STALL_TIMEOUT_MS) {
          const timeoutSeconds = Math.floor(TRANSFER_STALL_TIMEOUT_MS / 1000);
          queue.markStalled(item.id, `No transfer progress detected for ${timeoutSeconds}s`);
          pushTransferDiagnostic({
            transferId: item.id,
            status: "stalled",
            reason: `No transfer progress for ${timeoutSeconds}s. Resume to retry direct/relay path.`,
          });
        }
      }
    }, TRANSFER_STALL_SWEEP_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    refreshActiveSpace(activeSpaceId);
  }, [activeSpaceId, token]);

  useEffect(() => {
    activeSpaceIdRef.current = activeSpaceId;
  }, [activeSpaceId]);

  useEffect(() => {
    if (!socket?.connected) return;
    const previous = joinedRoomRef.current;
    if (previous && previous !== activeSpaceId) {
      socket.emit(EVENTS.ROOM_LEAVE, { spaceId: previous });
      joinedRoomRef.current = null;
    }
    if (activeSpaceId) {
      socket.emit(EVENTS.ROOM_JOIN, { spaceId: activeSpaceId });
      joinedRoomRef.current = activeSpaceId;
    } else {
      setSpaceRoomMessages([]);
    }
  }, [activeSpaceId, socket]);

  // Socket.IO connection
  useEffect(() => {
    if (!token) return;
    if (!clientIdRef.current) {
      clientIdRef.current = getOrCreateClientId();
    }
    const clientId = clientIdRef.current;
    manualDisconnectRef.current = false;

    const scheduleReconnect = (reason, errorCode = null) => {
      if (manualDisconnectRef.current || reconnectTimerRef.current || !token) return;
      clearStableConnectionTimer();
      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      const maxExponent = Math.floor(Math.log2(RECONNECT_BACKOFF.MAX_MS / RECONNECT_BACKOFF.BASE_MS));
      const exponent = Math.min(attempt - 1, maxExponent);
      const delayMs = RECONNECT_BACKOFF.BASE_MS * (2 ** exponent);
      transitionConnectionState(CONNECTION_STATES.RECONNECTING, { reason, attempt, delayMs, errorCode });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectSocket(`reconnect-attempt-${attempt}`);
      }, delayMs);
    };

    const connectSocket = (reason = "connect") => {
      if (manualDisconnectRef.current || !token) return;

      if (socketRef.current) {
        clearHeartbeatTimer();
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
      }

      transitionConnectionState(CONNECTION_STATES.CONNECTING, { reason, attempt: reconnectAttemptRef.current });
      const newSocket = io(config.serverUrl, { reconnection: false });
      socketRef.current = newSocket;
      setSocket(newSocket);

      newSocket.on("connect", () => {
        transitionConnectionState(CONNECTION_STATES.CONNECTED, { reason: "socket-connected", socketId: newSocket.id });
        console.log("Connected to server, sending HELLO...");
        newSocket.emit(EVENTS.HELLO, {
          clientId,
          clientVersion: CLIENT_VERSION,
        });
        clearStableConnectionTimer();
        stableConnectionTimerRef.current = setTimeout(() => {
          reconnectAttemptRef.current = 0;
          console.log("[ConnectionState] reconnect backoff reset after stable connection");
        }, RECONNECT_BACKOFF.STABLE_RESET_MS);
      });

      newSocket.on("connect_error", (error) => {
        console.error("Connection error:", error?.message || error);
        scheduleReconnect("connect_error", "SOCKET_CONNECT_ERROR");
      });

      newSocket.on("disconnect", (reasonText) => {
        clearHeartbeatTimer();
        resetPresenceState();
        if (manualDisconnectRef.current || reasonText === "io client disconnect") {
          clearReconnectTimer();
          clearStableConnectionTimer();
          transitionConnectionState(CONNECTION_STATES.DISCONNECTED, { reason: reasonText || "manual-disconnect" });
          return;
        }
        scheduleReconnect(`disconnect:${reasonText}`, "SOCKET_DISCONNECT");
      });

      newSocket.on(EVENTS.HELLO_ACK, ({ sessionId }) => {
        setConnectionSessionId(sessionId);
        connectionSessionIdRef.current = sessionId;
        console.log("HELLO acknowledged with session:", sessionId);
        newSocket.emit(EVENTS.AUTHENTICATE, token);
      });

      newSocket.on(EVENTS.AUTH_SUCCESS, (user) => {
        console.log("Authenticated as:", user);
        setCurrentUser(user);
        setAuthError("");
        if (isElectron) {
          Promise.all([
            window.electronAPI.getHost(),
            window.electronAPI.getFileServerPort(),
            window.electronAPI.getNatResult ? window.electronAPI.getNatResult() : Promise.resolve(null),
          ]).then(([host, port, nat]) => {
            const natInfo = nat || { strategy: 'relay-fallback', externalHost: null, externalPort: null, relayEligible: true };
            setConnectivityInfo({ host, port, nat: natInfo });
            newSocket.emit(EVENTS.CLIENT_INFO, {
              localEndpoint: { host, port },
              publicEndpoint: natInfo.externalHost && natInfo.externalPort
                ? { host: natInfo.externalHost, port: natInfo.externalPort }
                : undefined,
              nat: {
                upnp: natInfo.strategy === 'upnp-assist',
                natPmp: natInfo.strategy === 'nat-pmp',
                relayEligible: natInfo.relayEligible !== false,
                strategy: natInfo.strategy,
              },
            });
            runPreflight(newSocket);
          }).catch(() => {});
        } else {
          runPreflight(newSocket);
        }
        refreshSpaces();
        processQueue();
        if (activeSpaceId) {
          newSocket.emit(EVENTS.ROOM_JOIN, { spaceId: activeSpaceId });
          joinedRoomRef.current = activeSpaceId;
        }
      });

      newSocket.on(EVENTS.AUTH_ERROR, (msg) => {
        console.error("Auth error:", msg);
        setAuthError("Authentication failed. Please log in again.");
        setToken(null);
      });

      newSocket.on(EVENTS.USERS_LIST, (clients) => {
        const deduped = clients.reduce((acc, client) => {
          if (!acc.some((entry) => entry.user.id === client.user.id)) acc.push(client);
          return acc;
        }, []);
        setOnlineClients(deduped);
      });
      newSocket.on(EVENTS.USER_ONLINE, (client) => {
        setOnlineClients((prev) => {
          if (prev.some((entry) => entry.user.id === client.user.id)) return prev;
          return [...prev, client];
        });
      });
      newSocket.on(EVENTS.USER_OFFLINE, (user) => setOnlineClients((prev) => prev.filter((c) => c.user.id !== user.id)));
      newSocket.on(EVENTS.PEER_ONLINE, (peer) => {
        setOnlinePeers((prev) => {
          if (prev.some((entry) => entry.sessionId === peer.sessionId)) return prev;
          return [...prev, peer];
        });
      });
      newSocket.on(EVENTS.PEER_OFFLINE, (peer) => {
        setOnlinePeers((prev) => prev.filter((entry) => entry.sessionId !== peer.sessionId));
      });
      newSocket.on(EVENTS.USER_UPDATED, (client) => {
        setOnlineClients((prev) => {
          const i = prev.findIndex((c) => c.user.id === client.user.id);
          if (i >= 0) { const u = [...prev]; u[i] = client; return u; }
          return prev;
        });
      });

      // Bidirectional buddy request notifications
      newSocket.on(EVENTS.BUDDY_REQUESTED, (req) => {
        setBuddyRequests((prev) => {
          if (prev.some((r) => r.requestId === req.requestId)) return prev;
          return [...prev, req];
        });
        setDownloadMsg(`${req.from.username} sent you a buddy request`);
        setTimeout(() => setDownloadMsg(""), 4000);
      });
      newSocket.on(EVENTS.BUDDY_ACCEPTED, ({ friend }) => {
        setBuddies((prev) => {
          if (prev.some((b) => b.id === friend.id)) return prev;
          return [...prev, friend];
        });
        setDownloadMsg(`${friend.username} accepted your buddy request!`);
        setTimeout(() => setDownloadMsg(""), 4000);
        newSocket.emit(EVENTS.REFRESH_USERS);
      });

      // Someone asks me to approve a download — check trust policy first
      newSocket.on(EVENTS.DOWNLOAD_REQUEST, ({ requester, filePath, fileName, requesterId, requesterClientId }) => {
        const tier = getTrust(requester?.id);
        if (tier === 'allow') {
          const approveWithToken = async () => {
            const downloadToken = isElectron && window.electronAPI?.generateDownloadToken
              ? await window.electronAPI.generateDownloadToken(filePath).catch(() => null)
              : null;
            newSocket.emit(EVENTS.DOWNLOAD_APPROVE, { requesterId, filePath, fileName, downloadToken });
          };
          approveWithToken();
          return;
        }
        if (tier === 'deny') {
          newSocket.emit(EVENTS.DOWNLOAD_REJECT, { requesterId, filePath, fileName });
          return;
        }
        setDownloadRequest({
          requester,
          filePath,
          fileName,
          requesterId,
          requesterClientId: resolveDeviceId(requesterClientId),
          socket: newSocket,
        });
      });

      // My request to download was approved
      newSocket.on(EVENTS.DOWNLOAD_APPROVED, async ({ filePath, fileName: approvedFileName, ownerId, ownerUsername, ownerHost, port: remotePort, downloadToken }) => {
      const queue = queueRef.current;
      const transferId = queue?.list().find((item) => item.filePath === filePath && item.ownerId === ownerId && (item.status === TRANSFER_STATES.REQUESTING || item.status === TRANSFER_STATES.QUEUED))?.id;
      const item = transferId ? queue.get(transferId) : null;
      const fileName = approvedFileName || extractFileName(filePath);
      if (transferId) queue.setStatus(transferId, TRANSFER_STATES.CONNECTING, { ownerHost, ownerPort: remotePort, ownerUsername });
      activeDownloadRef.current = transferId || `ad-hoc-${Date.now()}`;
      setDownloadMsg(`Download approved by ${ownerUsername}. Starting download...`);

      // Byte offset for range-header resume (persisted from a previous interrupted transfer)
      const resumeOffset = item?.resumeOffset || 0;

      // Use the per-transfer token issued by the owner when they approved the request.
      // If not provided (e.g. older broker / non-Electron owner), fall back to our own
      // session token (works for same-machine downloads where both sides share a process).
      const fileServerToken = downloadToken || (
        isElectron && window.electronAPI?.getFileServerToken
          ? await window.electronAPI.getFileServerToken().catch(() => null)
          : null
      );

      try {
        const port = remotePort || 5555;
        const host = ownerHost || "localhost";
        const downloadUrl = `http://${host}:${port}/${encodeURIComponent(filePath)}`;
        if (transferId) {
          queue.setStatus(transferId, TRANSFER_STATES.DIRECT);
          const natStrategy = getNatStrategy(queue.get(transferId));
          const status = `${natStrategy}:start`;
          newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId, status });
          pushTransferDiagnostic({ transferId, status, reason: connectivityHint(status) });
        }
        console.log(`Download approved for ${filePath} from ${ownerUsername} (${transferId || "ad-hoc"}) resumeOffset=${resumeOffset}`);

        // Try direct HTTP – with a timeout so relay fallback can kick in
        let response;
        try {
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), DIRECT_DOWNLOAD_TIMEOUT_MS);
          const fetchHeaders = {};
          if (resumeOffset > 0) fetchHeaders['Range'] = `bytes=${resumeOffset}-`;
          if (fileServerToken) fetchHeaders['Authorization'] = `Bearer ${fileServerToken}`;
          response = await fetch(downloadUrl, { headers: fetchHeaders, signal: controller.signal });
          clearTimeout(timeoutHandle);
          if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
        } catch (directErr) {
          console.warn(`[Download] Direct HTTP failed (${directErr.message}), trying relay...`);
          if (transferId) {
            const status = "direct:failed:relay-attempt";
            newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId, status });
            pushTransferDiagnostic({ transferId, status, reason: connectivityHint(status) });
          }
          const relayErr = new Error(directErr.message);
          relayErr.useRelay = true;
          relayErr.ownerId = ownerId;
          relayErr.filePath = filePath;
          relayErr.resumeOffset = resumeOffset;
          relayErr.transferId = transferId;
          relayErr.fileName = fileName;
          throw relayErr;
        }

        const isPartial = response.status === 206;
        const contentLength = response.headers.get("content-length");
        const rangeTotal = contentLength ? parseInt(contentLength, 10) : 0;
        const total = isPartial ? resumeOffset + rangeTotal : (rangeTotal || 0);
        if (transferId && resumeOffset > 0) {
          queue.setStatus(transferId, TRANSFER_STATES.RESUMED);
        }
        if (transferId) queue.setStatus(transferId, TRANSFER_STATES.DOWNLOADING);

        setDownloadProgress({ filename: fileName, loaded: resumeOffset, total, transferId });
        if (transferId) queue.setProgress(transferId, resumeOffset, total);

        const reader = response.body.getReader();
        const chunks = [];
        let loaded = resumeOffset;
        const throttleBytesPerSecond = queue?.peerBytesPerSecond || DEFAULT_PEER_BYTES_PER_SECOND;
        const allowedChunk = Math.max(
          MIN_THROTTLE_CHUNK_BYTES,
          Math.floor((throttleBytesPerSecond * THROTTLE_CHUNK_INTERVAL_MS) / MS_PER_SECOND),
        );
        while (true) {
          const latest = transferId ? queue.get(transferId) : null;
          if (latest?.status === TRANSFER_STATES.PAUSED) {
            throw new Error("Paused");
          }
          const { done, value } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.length; offset += allowedChunk) {
            const sliced = value.slice(offset, offset + allowedChunk);
            chunks.push(sliced);
            loaded += sliced.length;
            if (transferId) queue.setProgress(transferId, loaded, total);
            setDownloadProgress({ filename: fileName, loaded, total, transferId });
            await new Promise((resolve) => setTimeout(resolve, THROTTLE_CHUNK_INTERVAL_MS));
          }
        }

        const blob = new Blob(chunks);
        const arrayBuffer = await blob.arrayBuffer();
        setDownloadProgress(null);
        // Reset resumeOffset now that we have the full data
        if (transferId) queue.update(transferId, { resumeOffset: 0 });

        if (isElectron) {
          const result = await window.electronAPI.saveFile(arrayBuffer, fileName);
          if (result.success) {
            setDownloadMsg(`Downloaded: ${fileName}`);
            setTimeout(() => setDownloadMsg(""), 3000);
            if (transferId) {
              queue.complete(transferId);
              const status = "direct:success";
              newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId, status });
              pushTransferDiagnostic({ transferId, status, reason: connectivityHint(status) });
            }
          } else if (result.canceled) {
            setDownloadMsg("Download canceled");
            setTimeout(() => setDownloadMsg(""), 2000);
            if (transferId) queue.markInterrupted(transferId);
          } else {
            setDownloadMsg(`Error saving file: ${result.error}`);
            if (transferId) queue.fail(transferId, result.error || "Save failed");
          }
        } else {
          // Browser fallback: trigger a download
          saveBlobInBrowser(new Blob([arrayBuffer]), fileName);
          setDownloadMsg(`Downloaded: ${fileName}`);
          setTimeout(() => setDownloadMsg(""), 3000);
          if (transferId) queue.complete(transferId);
        }
      } catch (err) {
        console.error("Download error:", err);
        if (err.message === "Paused") {
          setDownloadMsg(`Download paused: ${fileName}`);
          if (transferId) queue.markInterrupted(transferId);
        } else if (err.useRelay && newSocket.connected) {
          // ── Relay fallback execution ────────────────────────────────────
          setDownloadMsg(`Direct failed. Using broker relay for ${err.fileName}...`);
          const relayId = `relay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          newSocket.emit(EVENTS.RELAY_REQUEST, {
            relayId,
            ownerId: err.ownerId,
            filePath: err.filePath,
            byteOffset: err.resumeOffset || 0,
            transferId: err.transferId || null,
          });
          if (err.transferId) {
            queue.setStatus(err.transferId, TRANSFER_STATES.RELAY);
            const status = "relay:start";
            newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId: err.transferId, status });
            pushTransferDiagnostic({ transferId: err.transferId, status, reason: connectivityHint(status) });
          }
          activeRelayRef.current = {
            relayId,
            transferId: err.transferId,
            fileName: err.fileName,
            chunks: [],
            loaded: err.resumeOffset || 0,
            total: 0,
          };
          // Don't run finally block – relay handlers will clean up
          return;
        } else {
          setDownloadMsg(`Download failed: ${err.message}`);
          if (transferId) {
            queue.fail(transferId, err.message);
            const status = "direct:failed";
            newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId, status });
            pushTransferDiagnostic({ transferId, status, reason: connectivityHint(status) });
          }
        }
        setDownloadProgress(null);
      } finally {
        activeDownloadRef.current = null;
        processQueue();
      }
      });

      // ── Relay receive: chunk forwarded by broker ────────────────────────
      newSocket.on(EVENTS.RELAY_CHUNK_FWD, ({ relayId, data, offset }) => {
        const relay = activeRelayRef.current;
        if (!relay || relay.relayId !== relayId) return;
        // data arrives as a Buffer/Uint8Array or base64 string
        let chunk;
        if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
          chunk = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
        } else if (typeof data === 'string') {
          const bin = atob(data);
          chunk = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) chunk[i] = bin.charCodeAt(i);
        } else {
          return;
        }
        relay.chunks.push(chunk);
        relay.loaded += chunk.length;
        const queue = queueRef.current;
        if (relay.transferId) queue?.setProgress(relay.transferId, relay.loaded, relay.total);
        setDownloadProgress({ filename: relay.fileName, loaded: relay.loaded, total: relay.total, transferId: relay.transferId });
      });

      // ── Relay receive: broker signals done ─────────────────────────────
      newSocket.on(EVENTS.RELAY_DONE, async ({ relayId, error, fileName: relayFileName, totalBytes }) => {
        const relay = activeRelayRef.current;
        if (!relay || relay.relayId !== relayId) return;
        activeRelayRef.current = null;
        const queue = queueRef.current;
        const { transferId, fileName, chunks } = relay;

        if (error) {
          setDownloadMsg(`Relay failed: ${error}`);
          setDownloadProgress(null);
          if (transferId) {
            queue?.fail(transferId, error);
            const status = "relay:failed";
            newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId, status });
            pushTransferDiagnostic({ transferId, status, reason: connectivityHint(status) });
          }
          activeDownloadRef.current = null;
          processQueue();
          return;
        }

        const blob = new Blob(chunks);
        const arrayBuffer = await blob.arrayBuffer();
        setDownloadProgress(null);
        if (transferId) queue?.update(transferId, { resumeOffset: 0 });

        if (isElectron) {
          const result = await window.electronAPI.saveFile(arrayBuffer, relayFileName || fileName);
          if (result.success) {
            setDownloadMsg(`Downloaded (relay): ${relayFileName || fileName}`);
            setTimeout(() => setDownloadMsg(""), 3000);
            if (transferId) {
              queue?.complete(transferId);
              const status = "relay:success";
              newSocket.emit(EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId, status });
              pushTransferDiagnostic({ transferId, status, reason: connectivityHint(status) });
            }
          } else if (result.canceled) {
            setDownloadMsg("Download canceled");
            if (transferId) queue?.markInterrupted(transferId);
          } else {
            setDownloadMsg(`Error saving file: ${result.error}`);
            if (transferId) queue?.fail(transferId, result.error || "Save failed");
          }
        } else {
          saveBlobInBrowser(new Blob([arrayBuffer]), relayFileName || fileName);
          setDownloadMsg(`Downloaded (relay): ${relayFileName || fileName}`);
          setTimeout(() => setDownloadMsg(""), 3000);
          if (transferId) queue?.complete(transferId);
        }
        activeDownloadRef.current = null;
        processQueue();
      });

      // ── Relay serve: broker asks this client to stream a file ───────────
      newSocket.on(EVENTS.RELAY_SERVE, async ({ relayId, filePath: serveFilePath, byteOffset, requesterUsername }) => {
        if (!isElectron || !window.electronAPI?.readFileForRelay) return;
        console.log(`[Relay] Serving ${serveFilePath} to ${requesterUsername} from offset ${byteOffset}`);
        const RELAY_CHUNK_SIZE = RELAY_SERVE_CHUNK_SIZE;
        let offset = byteOffset || 0;
        let totalSize = 0;
        let fileName = "";
        try {
          while (true) {
            const result = await window.electronAPI.readFileForRelay(serveFilePath, offset, RELAY_CHUNK_SIZE);
            if (!result) {
              newSocket.emit(EVENTS.RELAY_END, { relayId, error: "File not available or not shared" });
              return;
            }
            if (totalSize === 0) { totalSize = result.totalSize; fileName = result.name; }
            const chunkData = result.data;
            const isFinal = offset + chunkData.byteLength >= totalSize;
            newSocket.emit(EVENTS.RELAY_CHUNK, { relayId, data: chunkData, offset });
            offset += chunkData.byteLength;
            if (isFinal || chunkData.byteLength === 0) break;
            // Brief yield between chunks to avoid flooding the socket
            await new Promise((r) => setTimeout(r, 10));
          }
          newSocket.emit(EVENTS.RELAY_END, { relayId, error: null, fileName, totalBytes: totalSize });
        } catch (err) {
          console.error("[Relay] Serve error:", err);
          newSocket.emit(EVENTS.RELAY_END, { relayId, error: err.message || "Serve error" });
        }
      });

      newSocket.on(EVENTS.DOWNLOAD_REJECTED, ({ filePath, ownerId }) => {
        setDownloadMsg("Download was rejected by the file owner");
        const queue = queueRef.current;
        const rejected = queue?.list().find((item) =>
          item.filePath === filePath &&
          item.status === TRANSFER_STATES.REQUESTING &&
          (ownerId === undefined || item.ownerId === ownerId)
        );
        if (rejected) queue.reject(rejected.id);
        setTimeout(() => setDownloadMsg(""), 3000);
        processQueue();
      });

      newSocket.on(EVENTS.DOWNLOAD_ERROR, ({ message }) => {
        console.error("Download error:", message);
        setDownloadMsg(`Error: ${message}`);
        const queue = queueRef.current;
        const queued = queue?.list().find((item) => item.status === TRANSFER_STATES.REQUESTING || item.status === TRANSFER_STATES.DOWNLOADING);
        if (queued) queue.fail(queued.id, message);
        setTimeout(() => setDownloadMsg(""), 3000);
        activeDownloadRef.current = null;
        processQueue();
      });

      newSocket.on(EVENTS.FILE_SEND_REQUESTED, ({ requestId, senderUsername, fileName, fileSize, senderId, senderClientId }) => {
        const tier = getTrust(senderId);
        if (tier === 'allow') {
          newSocket.emit(EVENTS.FILE_SEND_APPROVE, { requestId });
          return;
        }
        if (tier === 'deny') {
          newSocket.emit(EVENTS.FILE_SEND_REJECT, { requestId });
          return;
        }
        setSendRequest({
          requestId,
          senderUsername,
          fileName,
          fileSize,
          senderId,
          senderClientId: resolveDeviceId(senderClientId),
          socket: newSocket,
        });
      });

      newSocket.on(EVENTS.FILE_SEND_APPROVED, ({ requestId, recipientId, fileName }) => {
        setDownloadMsg(`Send approved by recipient #${recipientId}: ${fileName}`);
        setTimeout(() => setDownloadMsg(""), 3000);
      });

      newSocket.on(EVENTS.FILE_SEND_REJECTED, ({ requestId, fileName }) => {
        setDownloadMsg(`Send rejected: ${fileName}`);
        setTimeout(() => setDownloadMsg(""), 3000);
      });

      // Someone sent me a file directly (socket payload)
      newSocket.on(EVENTS.FILE_INCOMING, async ({ senderUsername, fileName, fileData, fileSize }) => {
      try {
        const binaryString = atob(fileData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        const arrayBuffer = bytes.buffer;

        if (isElectron) {
          const result = await window.electronAPI.saveFile(arrayBuffer, fileName);
          if (result.success) {
            setDownloadMsg(`File ${fileName} received from ${senderUsername}!`);
          } else if (result.canceled) {
            setDownloadMsg("Save canceled");
          }
        } else {
          saveBlobInBrowser(new Blob([arrayBuffer]), fileName);
          setDownloadMsg(`File ${fileName} received from ${senderUsername}!`);
        }
        setTimeout(() => setDownloadMsg(""), 3000);
      } catch (err) {
        console.error("Error receiving file:", err);
        setDownloadMsg(`Failed to receive ${fileName}`);
        setTimeout(() => setDownloadMsg(""), 3000);
      }
      });

      heartbeatTimerRef.current = setInterval(() => {
        if (!newSocket.connected) return;
        newSocket.emit(EVENTS.PING, { clientTime: Date.now() });
        processQueue();
      }, HEARTBEAT.INTERVAL_MS);

      // In-app messaging: receive a message and update conversation if drawer is open
      newSocket.on(EVENTS.MESSAGE_RECEIVE, (msg) => {
        // Handled inside MessagingDrawer component directly via socket prop.
        // Additionally track unread count when the chat drawer for the sender is not open.
        if (msg?.senderId) {
          setUnreadCounts((prev) => {
            const openPeerId = activeChatPeerRef.current?.id;
            if (openPeerId && openPeerId === msg.senderId) return prev;
            return { ...prev, [msg.senderId]: (prev[msg.senderId] || 0) + 1 };
          });
        }
      });

      newSocket.on(EVENTS.ROOM_HISTORY, ({ spaceId, messages }) => {
        if (spaceId !== activeSpaceIdRef.current) return;
        setSpaceRoomMessages(Array.isArray(messages) ? messages.slice(-ROOM_HISTORY_LIMIT) : []);
      });

      newSocket.on(EVENTS.ROOM_MESSAGE, ({ spaceId, message }) => {
        if (spaceId !== activeSpaceIdRef.current || !message) return;
        setSpaceRoomMessages((prev) => [...prev, message].slice(-ROOM_HISTORY_LIMIT));
      });

    };

    connectSocket("token-available");

    return () => {
      manualDisconnectRef.current = true;
      clearReconnectTimer();
      clearStableConnectionTimer();
      resetPresenceState();
      clearHeartbeatTimer();
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setSocket(null);
    };
  }, [token]);

  useEffect(() => {
    if (!queueRef.current) {
      queueRef.current = new TransferQueue({
        maxRetries: 3,
        maxActive: bandwidthSettings.maxActive,
        globalBytesPerSecond: bandwidthSettings.globalBytesPerSecond,
        peerBytesPerSecond: bandwidthSettings.peerBytesPerSecond,
      });
      const unsubscribe = queueRef.current.subscribe((items) => setTransferQueueItems([...items]));
      return () => unsubscribe();
    }
  }, []);

  // Listen for file list updates from Electron
  useEffect(() => {
    if (!window.electronAPI?.onUpdateFileList) return;
    window.electronAPI.onUpdateFileList((tree) => {
      console.log("Received file tree from Electron:", tree);
      setMyFiles(tree);
      if (window.electronAPI?.getCurrentFolder) {
        window.electronAPI.getCurrentFolder().then((folder) => {
          setSharedFolderPath(folder || "");
        }).catch(() => {});
      }
      if (socket?.connected) {
        socket.emit(EVENTS.SHARE_FILES, tree);
      }
    });
  }, [socket]);

  // User search debounce
  useEffect(() => {
    if (!userSearchQuery.trim() || userSearchQuery.length < 2) {
      setUserSearchResults([]);
      setUserSearchError("");
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(
          `${config.serverUrl}/users/search?q=${encodeURIComponent(userSearchQuery)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await r.json().catch(() => null);
        if (r.ok) {
          setUserSearchResults(Array.isArray(data) ? data : []);
          setUserSearchError("");
          return;
        }
        setUserSearchResults([]);
        setUserSearchError(data?.message || "User search is currently unavailable. You can still add buddies by exact username.");
      } catch {
        setUserSearchResults([]);
        setUserSearchError("Failed to search users. You can still add by exact username.");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearchQuery, token]);

  const handleLogin = (authToken, username) => {
    logLifecycleDebug("auth:login", connectionState, { reason: "token-set", username });
    setToken(authToken);
    // currentUser is populated from AUTH_SUCCESS once the socket authenticates;
    // setting a partial object here would expose undefined id/role to the render.
    if (showOnboarding && onboardingStep === 0) setOnboardingStep(1);
    // Persist token for auto-restore on Electron restart
    if (isElectron && window.electronAPI?.storeToken) {
      window.electronAPI.storeToken(authToken).catch(() => {});
    }
  };

  const handleLogout = () => {
    logLifecycleDebug("auth:logout", connectionState, { reason: "user-logout" });
    manualDisconnectRef.current = true;
    clearReconnectTimer();
    clearStableConnectionTimer();
    transitionConnectionState(CONNECTION_STATES.DISCONNECTED, { reason: "logout" });
    resetPresenceState();
    clearHeartbeatTimer();
    if (socket) socket.disconnect();
    setToken(null);
    setCurrentUser(null);
    setSocket(null);
    setMyFiles([]);
    // Clear persisted token
    if (isElectron && window.electronAPI?.clearStoredToken) {
      window.electronAPI.clearStoredToken().catch(() => {});
    }
  };

  const handleShareFolder = async () => {
    if (!isElectron) {
      setDownloadMsg("Folder sharing is only available in the desktop app.");
      setTimeout(() => setDownloadMsg(""), 2500);
      return;
    }
    await window.electronAPI.selectFolder();
    if (showOnboarding && onboardingStep <= 3) {
      setOnboardingStep(4);
      localStorage.setItem(ONBOARDING_DONE_KEY, "true");
      setTimeout(() => setShowOnboarding(false), 800);
    }
  };

  const handleDownloadRequest = (filePath, ownerId, fileNameHint) => {
    if (!socket) return;
    const fileName = fileNameHint || extractFileName(filePath);
    logLifecycleDebug("download:request", connectionState, { reason: "user-action", filePath, ownerId, fileName });
    const owner = onlineClients.find((client) => client.user.id === ownerId);
    const queue = queueRef.current;
    if (!queue) return;
    queue.enqueue({
      ownerId,
      ownerUsername: owner?.user?.username || "",
      filePath,
      fileName,
      ownerHost: owner?.endpoints?.public?.host || owner?.endpoints?.local?.host || null,
      ownerPort: owner?.endpoints?.public?.port || owner?.endpoints?.local?.port || null,
      relayEligible: owner?.endpoints?.relayEligible !== false,
    });
    setDownloadMsg(`Queued download: ${fileName}`);
    processQueue();
  };

  const handleCreateSpace = async () => {
    if (!newSpaceName.trim()) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newSpaceName.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to create network");
      setNewSpaceName("");
      setActiveSpaceId(data.id);
      await refreshSpaces();
      await refreshActiveSpace(data.id);
      setDownloadMsg(`Network created: ${data.name}`);
      setTimeout(() => setDownloadMsg(""), 2500);
      if (showOnboarding && onboardingStep <= 1) setOnboardingStep(2);
    } catch (err) {
      setDownloadMsg(err.message || "Failed to create network");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const pushTransferDiagnostic = (entry) => {
    setTransferDiagnostics((prev) => {
      const next = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          at: new Date().toISOString(),
          ...entry,
        },
        ...prev,
      ];
      return next.slice(0, 25);
    });
  };

  const addWishlistItem = () => {
    const value = wishlistQuery.trim().toLowerCase();
    if (!value) return;
    setWishlistItems((prev) => {
      if (prev.includes(value)) return prev;
      const next = [value, ...prev].slice(0, 20);
      persistWishlist(next);
      return next;
    });
    setWishlistQuery("");
  };

  const removeWishlistItem = (item) => {
    setWishlistItems((prev) => {
      const next = prev.filter((v) => v !== item);
      persistWishlist(next);
      return next;
    });
  };

  const sendRoomMessage = () => {
    const body = spaceRoomBody.trim();
    if (!body || !activeSpaceId || !socket?.connected) return;
    socket.emit(EVENTS.ROOM_MESSAGE_SEND, { spaceId: activeSpaceId, body });
    setSpaceRoomBody("");
  };

  const handleCreateInvite = async () => {
    if (!activeSpaceId) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces/${activeSpaceId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ maxUses: DEFAULT_INVITE_MAX_USES, expiresInHours: DEFAULT_INVITE_EXPIRES_HOURS }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to create invite");
      await refreshActiveSpace(activeSpaceId);
      setInviteCodeToCreate(data.code);
      setDownloadMsg(`Invite created: ${data.code}`);
      setTimeout(() => setDownloadMsg(""), 3000);
      if (showOnboarding && onboardingStep <= 2) setOnboardingStep(3);
    } catch (err) {
      setDownloadMsg(err.message || "Failed to create invite");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleJoinByCode = async () => {
    if (!joinInviteCode.trim()) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces/join-by-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inviteCode: joinInviteCode.trim().toUpperCase() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to join by code");
      setJoinInviteCode("");
      setDownloadMsg(data.status === "pending" ? "Join request submitted to owner" : "Joined network");
      setTimeout(() => setDownloadMsg(""), 3000);
      await refreshSpaces();
    } catch (err) {
      setDownloadMsg(err.message || "Failed to join by code");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleApproveJoinRequest = async (requestId) => {
    if (!activeSpaceId) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces/${activeSpaceId}/requests/${requestId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to approve");
      await refreshActiveSpace(activeSpaceId);
    } catch (err) {
      setDownloadMsg(err.message || "Failed to approve join request");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleRejectJoinRequest = async (requestId) => {
    if (!activeSpaceId) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces/${activeSpaceId}/requests/${requestId}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to reject");
      await refreshActiveSpace(activeSpaceId);
    } catch (err) {
      setDownloadMsg(err.message || "Failed to reject join request");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleKickMember = async (memberId, username) => {
    if (!activeSpaceId) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces/${activeSpaceId}/members/${memberId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to remove member");
      await refreshActiveSpace(activeSpaceId);
      setDownloadMsg(`Removed ${username} from network`);
      setTimeout(() => setDownloadMsg(""), 2500);
    } catch (err) {
      setDownloadMsg(err.message || "Failed to remove member");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleLeaveSpace = async () => {
    if (!activeSpaceId || !activeSpace) return;
    if (activeSpace.myRole === "owner") {
      setDownloadMsg("Owner cannot leave network; transfer or delete network first");
      setTimeout(() => setDownloadMsg(""), 3000);
      return;
    }
    const confirmed = window.confirm(`Leave network "${activeSpace.name}"?`);
    if (!confirmed) return;
    try {
      const r = await fetch(`${config.serverUrl}/spaces/${activeSpaceId}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to leave network");
      setDownloadMsg(`Left network: ${activeSpace.name}`);
      setTimeout(() => setDownloadMsg(""), 2500);
      setActiveSpaceId(null);
      setActiveSpace(null);
      await refreshSpaces();
    } catch (err) {
      setDownloadMsg(err.message || "Failed to leave network");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleApproveDownload = (alwaysAllow = false) => {
    if (downloadRequest?.socket) {
      if (alwaysAllow && downloadRequest.requester?.id) {
        setTrust(downloadRequest.requester.id, 'allow');
      }
      const approveWithToken = async () => {
        const downloadToken = isElectron && window.electronAPI?.generateDownloadToken
          ? await window.electronAPI.generateDownloadToken(downloadRequest.filePath).catch(() => null)
          : null;
        downloadRequest.socket.emit(EVENTS.DOWNLOAD_APPROVE, {
          requesterId: downloadRequest.requesterId,
          filePath: downloadRequest.filePath,
          fileName: downloadRequest.fileName,
          downloadToken,
        });
      };
      approveWithToken();
      setDownloadMsg(`Approved download request from ${downloadRequest.requester.username}`);
      setTimeout(() => setDownloadMsg(""), 3000);
    }
    setDownloadRequest(null);
  };

  const handleRejectDownload = (alwaysDeny = false) => {
    if (downloadRequest?.socket) {
      if (alwaysDeny && downloadRequest.requester?.id) {
        setTrust(downloadRequest.requester.id, 'deny');
      }
      downloadRequest.socket.emit(EVENTS.DOWNLOAD_REJECT, {
        requesterId: downloadRequest.requesterId,
        filePath: downloadRequest.filePath,
        fileName: downloadRequest.fileName,
      });
      setDownloadMsg(`Rejected download request from ${downloadRequest.requester.username}`);
      setTimeout(() => setDownloadMsg(""), 3000);
    }
    setDownloadRequest(null);
  };

  const handleApproveSend = (alwaysAllow = false) => {
    if (sendRequest?.socket) {
      if (alwaysAllow && sendRequest.senderId) {
        setTrust(sendRequest.senderId, 'allow');
      }
      sendRequest.socket.emit(EVENTS.FILE_SEND_APPROVE, { requestId: sendRequest.requestId });
      setDownloadMsg(`Accepted file send from ${sendRequest.senderUsername}`);
      setTimeout(() => setDownloadMsg(""), 3000);
    }
    setSendRequest(null);
  };

  const handleRejectSend = (alwaysDeny = false) => {
    if (sendRequest?.socket) {
      if (alwaysDeny && sendRequest.senderId) {
        setTrust(sendRequest.senderId, 'deny');
      }
      sendRequest.socket.emit(EVENTS.FILE_SEND_REJECT, { requestId: sendRequest.requestId });
      setDownloadMsg(`Rejected file send from ${sendRequest.senderUsername}`);
      setTimeout(() => setDownloadMsg(""), 3000);
    }
    setSendRequest(null);
  };

  const handleAddBuddy = async (usernameArg) => {
    const uname = usernameArg || buddyUsername;
    if (!uname.trim()) return;
    try {
      const response = await fetch(`${config.serverUrl}/buddies/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: uname })
      });
      const data = await response.json();
      setDownloadMsg(response.ok ? `Buddy request sent to ${uname}` : data.message || "Failed to send buddy request");
      setTimeout(() => setDownloadMsg(""), 3000);
      setBuddyUsername(""); setShowBuddyDialog(false);
    } catch (err) {
      console.error("Add buddy error:", err);
      setDownloadMsg("Failed to send buddy request");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleAcceptBuddyRequest = async (requestId, fromUsername) => {
    try {
      const r = await fetch(`${config.serverUrl}/buddies/request/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId })
      });
      if (r.ok) {
        setBuddyRequests((prev) => prev.filter((req) => req.requestId !== requestId));
        setDownloadMsg(`Accepted buddy request from ${fromUsername}`);
        setTimeout(() => setDownloadMsg(""), 3000);
        if (socket?.connected) socket.emit(EVENTS.REFRESH_USERS);
        const br = await fetch(`${config.serverUrl}/buddies`, { headers: { Authorization: `Bearer ${token}` } });
        if (br.ok) setBuddies(await br.json());
      }
    } catch (err) {
      console.error("Accept buddy request error:", err);
    }
  };

  const handleDeclineBuddyRequest = async (requestId, fromUsername) => {
    try {
      const r = await fetch(`${config.serverUrl}/buddies/request/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId })
      });
      if (r.ok) {
        setBuddyRequests((prev) => prev.filter((req) => req.requestId !== requestId));
        setDownloadMsg(`Declined buddy request from ${fromUsername}`);
        setTimeout(() => setDownloadMsg(""), 3000);
      }
    } catch (err) {
      console.error("Decline buddy request error:", err);
    }
  };

  const handleRemoveBuddy = async (buddyId, username) => {
    try {
      const response = await fetch(`${config.serverUrl}/buddies/${buddyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        setBuddies(buddies.filter(b => b.id !== buddyId));
        setDownloadMsg(`Removed ${username} from buddy list`);
        setTimeout(() => setDownloadMsg(""), 3000);
        setOnlineClients(prev => prev.filter(c => c.user.id !== buddyId));
      }
    } catch (err) {
      console.error("Remove buddy error:", err);
      setDownloadMsg("Failed to remove buddy");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const isBuddy = (userId) => buddies.some(b => b.id === userId);

  const handleStopSharing = async () => {
    if (!isElectron) {
      setDownloadMsg("Stop sharing is only available in the desktop app.");
      setTimeout(() => setDownloadMsg(""), 2500);
      return;
    }
    try {
      await window.electronAPI.stopSharing();
      setMyFiles([]); setSharedFolderPath("");
      if (socket?.connected) socket.emit(EVENTS.SHARE_FILES, []);
      setDownloadMsg("Stopped sharing folder");
      setTimeout(() => setDownloadMsg(""), 2000);
    } catch (err) {
      console.error("Stop sharing error:", err);
      setDownloadMsg("Failed to stop sharing");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleChangeFolderFromSettings = () => {
    handleShareFolder();
    setShowSettings(false);
  };

  const handleSendFile = async (recipientId, recipientUsername) => {
    if (!isElectron) {
      setDownloadMsg("Sending files requires the desktop app.");
      setTimeout(() => setDownloadMsg(""), 2500);
      return;
    }
    try {
      const filePath = await window.electronAPI.selectFile();
      if (!filePath) return;
      setDownloadMsg(`Sending file to ${recipientUsername}...`);
      const fileData = await window.electronAPI.readFile(filePath);
      const uint8Array = new Uint8Array(fileData.data);
      let binaryString = "";
      for (let i = 0; i < uint8Array.length; i++) binaryString += String.fromCharCode(uint8Array[i]);
      const base64Data = btoa(binaryString);
      socket.emit(EVENTS.FILE_SEND_REQUEST, {
        recipientId, fileName: fileData.name, fileData: base64Data, fileSize: fileData.size
      });
      setDownloadMsg(`Send request submitted to ${recipientUsername}`);
      setTimeout(() => setDownloadMsg(""), 3000);
    } catch (err) {
      console.error("Send file error:", err);
      setDownloadMsg("Failed to send file");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  const handleDrop = async (e, recipientId, recipientUsername) => {
    e.preventDefault(); setDragOver(null);
    if (!isElectron) {
      setDownloadMsg("Drag & drop send requires the desktop app.");
      setTimeout(() => setDownloadMsg(""), 2500);
      return;
    }
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    const file = files[0];
    setDownloadMsg(`Sending ${file.name} to ${recipientUsername}...`);
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const arrayBuffer = event.target.result;
        const uint8Array = new Uint8Array(arrayBuffer);
        let binaryString = "";
        for (let i = 0; i < uint8Array.length; i++) binaryString += String.fromCharCode(uint8Array[i]);
        const base64Data = btoa(binaryString);
        socket.emit(EVENTS.FILE_SEND_REQUEST, {
          recipientId, fileName: file.name, fileData: base64Data, fileSize: file.size
        });
        setDownloadMsg(`Send request submitted to ${recipientUsername}`);
        setTimeout(() => setDownloadMsg(""), 3000);
      };
      reader.onerror = () => {
        setDownloadMsg("Failed to read file");
        setTimeout(() => setDownloadMsg(""), 3000);
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      console.error("Drop file error:", err);
      setDownloadMsg("Failed to send file");
      setTimeout(() => setDownloadMsg(""), 3000);
    }
  };

  if (tokenLoading) {
    return <div className="loading-screen"><p>Loading…</p></div>;
  }

  if (!token) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  return (
    <div className="app-container">
      {!isElectron && (
        <div className="browser-warning">
          Running in browser-only mode: native folder and file dialogs are disabled.
        </div>
      )}

      <ConfirmationDialog
        isOpen={downloadRequest !== null}
        onConfirm={handleApproveDownload}
        onCancel={handleRejectDownload}
        title="Download Request"
        message={downloadRequest ? `${downloadRequest.requester.username} (${resolveDeviceId(downloadRequest.requesterClientId)}) wants to download: ${downloadRequest.fileName || extractFileName(downloadRequest.filePath)}` : ""}
        confirmText="Approve"
        cancelText="Reject"
        onAlwaysAllow={() => handleApproveDownload(true)}
        onAlwaysDeny={() => handleRejectDownload(true)}
      />

      <ConfirmationDialog
        isOpen={sendRequest !== null}
        onConfirm={handleApproveSend}
        onCancel={handleRejectSend}
        title="Incoming File Send"
        message={sendRequest ? `${sendRequest.senderUsername} (${resolveDeviceId(sendRequest.senderClientId)}) wants to send: ${sendRequest.fileName}` : ""}
        confirmText="Accept"
        cancelText="Reject"
        onAlwaysAllow={() => handleApproveSend(true)}
        onAlwaysDeny={() => handleRejectSend(true)}
      />

      {downloadProgress && (
        <ProgressBar filename={downloadProgress.filename} loaded={downloadProgress.loaded} total={downloadProgress.total} />
      )}

      {authError && (
        <div className="auth-error-banner">
          {authError}
          <button onClick={() => setAuthError("")}>✕</button>
        </div>
      )}

      <ConfirmationDialog
        isOpen={showBuddyDialog}
        onConfirm={() => handleAddBuddy()}
        onCancel={() => { setShowBuddyDialog(false); setBuddyUsername(""); setUserSearchResults([]); setUserSearchQuery(""); setUserSearchError(""); }}
        title="Add Buddy"
        message={
          <div>
            <p>Search for a user to add as buddy:</p>
            <input
              type="text"
              value={userSearchQuery}
              onChange={(e) => { setUserSearchQuery(e.target.value); setBuddyUsername(e.target.value); }}
              placeholder="Search username…"
              className="buddy-input"
              autoFocus
            />
            {userSearchError && (
              <p className="help-text">{userSearchError}</p>
            )}
            {userSearchResults.length > 0 && (
              <ul className="user-search-results">
                {userSearchResults.map((u) => (
                  <li key={u.id}>
                    <button onClick={() => { setBuddyUsername(u.username); setUserSearchQuery(u.username); setUserSearchResults([]); setUserSearchError(""); }}>
                      {u.username}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        }
        confirmText="Send Request"
        cancelText="Cancel"
      />

      <SettingsPage
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        sharedFolder={sharedFolderPath}
        onChangeFolder={handleChangeFolderFromSettings}
        onStopSharing={handleStopSharing}
        connectivityInfo={connectivityInfo}
        transferDiagnostics={transferDiagnostics}
        bandwidthSettings={bandwidthSettings}
        onBandwidthChange={(settings) => {
          setBandwidthSettings(settings);
          if (queueRef.current) {
            queueRef.current.globalBytesPerSecond = settings.globalBytesPerSecond;
            queueRef.current.peerBytesPerSecond = settings.peerBytesPerSecond;
            queueRef.current.maxActive = settings.maxActive;
          }
        }}
      />

      <AdminPanel isOpen={showAdmin} onClose={() => setShowAdmin(false)} token={token} />

      {activeChatPeer && (
        <MessagingDrawer
          isOpen={activeChatPeer !== null}
          onClose={() => { activeChatPeerRef.current = null; setActiveChatPeer(null); }}
          peer={activeChatPeer}
          token={token}
          socket={socket}
          currentUserId={currentUser?.id}
        />
      )}

      <header>
        <h1>Orchard</h1>
        <div className="user-info">
          Logged in as: <strong>{currentUser?.username}</strong>
          <span className="peer-presence-pill" title="Stable local device identity fingerprint">
            Device: {(clientIdRef.current || "pending").slice(0, 12)}
          </span>
          <span className={`connection-state-pill state-${connectionState.toLowerCase()}`}>
            Broker: {connectionState}
          </span>
          <span className="peer-presence-pill" title="Live peer sessions from broker presence events">
            Peers online: {onlinePeers.length}
          </span>
          {pendingActionCount > 0 && (
            <span className="notification-pill notification-pending" title="Pending actions (buddy, transfer, network requests)">
              🔔 {pendingActionCount}
            </span>
          )}
          {totalUnreadMessages > 0 && (
            <span className="notification-pill notification-unread" title="Unread messages">
              💬 {totalUnreadMessages}
            </span>
          )}
          <button onClick={() => setShowSettings(true)} className="settings-btn" title="Settings">⚙️ Settings</button>
          <button onClick={() => setShowBuddyDialog(true)} className="buddy-btn" title="Manage Buddies">👥 Buddies ({buddies.length})</button>
          {currentUser?.role === "admin" && (
            <button onClick={() => setShowAdmin(true)} className="admin-btn" title="Admin Panel">🛡️ Admin</button>
          )}
          <button onClick={handleLogout} className="logout-btn">Logout</button>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀️" : "🌙"}</button>
        </div>
      </header>

      {buddyRequests.length > 0 && (
        <div className="buddy-requests-banner">
          <strong>Buddy Requests:</strong>
          {buddyRequests.map((req) => (
            <span key={req.requestId} className="buddy-request-item">
              {req.from.username}
              <button className="btn-accept-small" onClick={() => handleAcceptBuddyRequest(req.requestId, req.from.username)}>Accept</button>
              <button className="btn-decline-small" onClick={() => handleDeclineBuddyRequest(req.requestId, req.from.username)}>Decline</button>
            </span>
          ))}
        </div>
      )}

      <div className="main-content">
        <section className="my-files">
          <h2>Network / Space</h2>
          <div className="file-list">
            <div className="folder-actions">
              <input
                type="text"
                value={newSpaceName}
                onChange={(e) => setNewSpaceName(e.target.value)}
                placeholder="New network name"
                className="buddy-input"
              />
              <button onClick={handleCreateSpace}>Create Network</button>
            </div>
            <div className="folder-actions">
              <input
                type="text"
                value={joinInviteCode}
                onChange={(e) => setJoinInviteCode(e.target.value.toUpperCase())}
                placeholder="Invite code"
                className="buddy-input"
              />
              <button onClick={handleJoinByCode}>Join by Code</button>
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <strong>Your Networks</strong>
              {spaces.length === 0 ? <p>None yet.</p> : (
                <ul>
                  {spaces.map((space) => (
                    <li key={space.id}>
                      <button onClick={() => setActiveSpaceId(space.id)}>
                        {space.name} ({space.myRole})
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {activeSpace && (
              <div style={{ marginTop: "0.75rem" }}>
                <div><strong>Active:</strong> {activeSpace.name}</div>
                <div><strong>Owner:</strong> {activeSpace.owner?.username}</div>
                {activeSpace.myRole !== "owner" && (
                  <div className="folder-actions" style={{ marginTop: "0.5rem" }}>
                    <button onClick={handleLeaveSpace}>Leave Network</button>
                  </div>
                )}
                {activeSpace.myRole === "owner" && (
                  <>
                    <div className="folder-actions">
                      <button onClick={handleCreateInvite}>Create Invite</button>
                      {inviteCodeToCreate && <span>Latest code: <strong>{inviteCodeToCreate}</strong></span>}
                    </div>
                    {spaceInvites.length > 0 && (
                      <ul>
                        {spaceInvites.slice(0, 3).map((inv) => (
                          <li key={inv.id}>{inv.code} {inv.revoked ? "(revoked)" : ""}</li>
                        ))}
                      </ul>
                    )}
                    <div style={{ marginTop: "0.5rem" }}>
                      <strong>Join Requests</strong>
                      {spaceJoinRequests.length === 0 ? <p>None pending.</p> : (
                        <ul>
                          {spaceJoinRequests.map((req) => (
                            <li key={req.id}>
                              {req.requesterUsername}
                              <button onClick={() => handleApproveJoinRequest(req.id)}>Approve</button>
                              <button onClick={() => handleRejectJoinRequest(req.id)}>Reject</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
                <div style={{ marginTop: "0.5rem" }}>
                  <strong>Members</strong>
                  <ul>
                    {(activeSpace.members || []).map((m) => (
                      <li key={m.userId}>
                        {m.username} ({m.role})
                        {activeSpace.myRole === "owner" && m.role !== "owner" && (
                          <button onClick={() => handleKickMember(m.userId, m.username)}>Kick</button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="settings-info" style={{ marginTop: "0.75rem" }}>
                  <h3>Private Room Chat</h3>
                  <div className="room-chat-log">
                    {spaceRoomMessages.length === 0 ? (
                      <p>No room messages yet.</p>
                    ) : (
                      <ul>
                        {spaceRoomMessages.map((m, idx) => (
                          <li key={`${m.id || m.createdAt || "m"}-${idx}`}>
                            <strong>{m.senderUsername || "unknown"}:</strong> {m.body}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="folder-actions">
                    <input
                      type="text"
                      value={spaceRoomBody}
                      onChange={(e) => setSpaceRoomBody(e.target.value)}
                      placeholder="Message private room"
                      className="buddy-input"
                    />
                    <button onClick={sendRoomMessage}>Send</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="my-files">
          <h2>My Shared Files</h2>
          <button onClick={handleShareFolder}>📁 Share a Folder</button>
          {showOnboarding && (
            <div className="settings-info" style={{ marginTop: "0.8rem" }}>
              <h3>First-run Wizard (v0)</h3>
              <p>Step {Math.min(onboardingStep + 1, 5)} / 5: {[
                "Create account / login",
                "Create network",
                "Create invite and share with friend",
                "Share a folder",
                "Done",
              ][Math.min(onboardingStep, 4)]}</p>
              <p>Preflight: broker={preflight.broker ? "ok" : "pending"}, nat={preflight.nat}, relay={preflight.relayEligible ? "ok" : "unknown"}, desktop={preflight.desktop ? "ok" : "browser-only"}</p>
              <button onClick={() => setShowOnboarding(false)}>Dismiss</button>
            </div>
          )}
          <div className="file-list">
            {myFiles.length > 0 ? <FileTree tree={myFiles} /> : <p>No files shared yet. Click "Share a Folder" to begin.</p>}
          </div>
        </section>

        <section className="online-users">
          <div className="section-header">
            <h2>Online Users ({onlineClients.length})</h2>
            {onlineClients.length > 0 && (
              <div className="search-bar">
                <input
                  type="text"
                  placeholder="🔍 Search files across all peers..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                />
                {searchQuery && (
                  <button className="clear-search" onClick={() => setSearchQuery("")} title="Clear search">✕</button>
                )}
              </div>
            )}
          </div>

          {searchQuery.trim() && (
            <SearchResultsPanel
              searchQuery={searchQuery.trim()}
              results={globalSearchResults}
              isBuddy={isBuddy}
              onDownload={handleDownloadRequest}
            />
          )}

          {onlineClients.length === 0 ? (
            <p>No other users online</p>
          ) : (
            <div className="users-list">
              {onlineClients.map((client) => (
                <div
                  key={client.user.id}
                  className={`user-card ${isBuddy(client.user.id) ? 'buddy' : ''} ${dragOver === client.user.id ? 'drag-over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(client.user.id); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => handleDrop(e, client.user.id, client.user.username)}
                >
                  <div className="user-card-header">
                    <h3>
                      👤 {client.user.username}
                      {isBuddy(client.user.id) && <span className="buddy-badge" title="Buddy">⭐</span>}
                    </h3>
                    <small title="Peer device identity/fingerprint">
                      Device: {resolveDeviceId(client.clientId).slice(0, 12)}
                    </small>
                    <div className="user-actions">
                      <button
                        className="btn-message"
                        onClick={() => {
                          activeChatPeerRef.current = client.user;
                          setActiveChatPeer(client.user);
                          setUnreadCounts((prev) => {
                            const next = { ...prev };
                            delete next[client.user.id];
                            return next;
                          });
                        }}
                        title="Message"
                      >
                        💬{unreadCounts[client.user.id] > 0 && (
                          <span className="unread-badge">{unreadCounts[client.user.id]}</span>
                        )}
                      </button>
                      <button className="btn-send-file" onClick={() => handleSendFile(client.user.id, client.user.username)} title="Send a file">📤 Send</button>
                      {isBuddy(client.user.id) ? (
                        <button className="btn-remove-buddy" onClick={() => handleRemoveBuddy(client.user.id, client.user.username)} title="Remove from buddies">✕ Remove</button>
                      ) : (
                        <button className="btn-add-buddy" onClick={() => handleAddBuddy(client.user.username)} title="Send buddy request">+ Add Buddy</button>
                      )}
                    </div>
                  </div>

                  <div className="drop-zone-hint">📎 Drag & drop files here to send</div>

                  {client.files && client.files.length > 0 ? (
                    <div className="file-list">
                      <FileTree
                        tree={client.files}
                        onDownload={(filePath, fileNameHint) => handleDownloadRequest(filePath, client.user.id, fileNameHint)}
                        searchQuery={searchQuery}
                      />
                    </div>
                  ) : (
                    <p className="no-files">Not sharing any files</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="peer-presence-panel">
        <strong>Peer Presence</strong>: {onlinePeers.length === 0 ? " none" : ""}
        {onlinePeers.length > 0 && (
          <ul className="peer-presence-list">
            {onlinePeers.map((peer) => (
              <li key={peer.sessionId}>
                {peer.clientId} ({peer.reason ?? "online"})
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="peer-presence-panel">
        <strong>Transfer Diagnostics</strong>
        {transferDiagnostics.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <ul className="peer-presence-list">
            {transferDiagnostics.slice(0, 8).map((d) => (
              <li key={d.id}>
                <code>{d.transferId}</code> — <strong>{d.status}</strong> — {d.reason}
              </li>
            ))}
          </ul>
        )}
      </div>

      <WishlistPanel
        wishlistItems={wishlistItems}
        wishlistMatches={wishlistMatches}
        wishlistQuery={wishlistQuery}
        onQueryChange={setWishlistQuery}
        onAdd={addWishlistItem}
        onRemove={removeWishlistItem}
        onSearch={setSearchQuery}
      />

      {downloadMsg && <div className="status-msg">{downloadMsg}</div>}
      <TransferQueuePanel
        items={transferQueueItems}
        onResume={(id) => { queueRef.current?.resume(id); processQueue(); }}
        onPause={(id) => queueRef.current?.pause(id)}
        onReorder={(sourceId, targetId) => {
          queueRef.current?.moveQueuedTo(sourceId, targetId);
          processQueue();
        }}
        onMoveUp={(id) => {
          queueRef.current?.moveQueued(id, "up");
          processQueue();
        }}
        onMoveDown={(id) => {
          queueRef.current?.moveQueued(id, "down");
          processQueue();
        }}
        onPauseAll={() => {
          transferQueueItems.forEach((item) => {
            if (
              item.status === TRANSFER_STATES.DOWNLOADING ||
              item.status === TRANSFER_STATES.REQUESTING ||
              item.status === TRANSFER_STATES.RELAY
            ) {
              queueRef.current?.pause(item.id);
            }
          });
        }}
        onResumeAll={() => {
          transferQueueItems.forEach((item) => {
            if (
              item.status === TRANSFER_STATES.PAUSED ||
              item.status === TRANSFER_STATES.STALLED ||
              item.status === TRANSFER_STATES.FAILED
            ) {
              queueRef.current?.resume(item.id);
            }
          });
          processQueue();
        }}
      />
    </div>
  );
}
