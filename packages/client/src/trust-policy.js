/**
 * Orchard Trust Policy
 *
 * Manages per-peer trust tiers stored in localStorage.
 *
 * Tiers:
 *   'manual'  – ask each time (default)
 *   'allow'   – always approve without prompting
 *   'deny'    – always reject without prompting
 */

const STORAGE_KEY = 'orchard.trustPolicy.v1';
const LEGACY_STORAGE_KEY = 'sanctumshare.trustPolicy.v1';
const VALID_TIERS = Object.freeze(['manual', 'allow', 'deny']);

function loadPolicy() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) return {};
      const parsedLegacy = JSON.parse(legacyRaw);
      if (typeof parsedLegacy !== 'object' || parsedLegacy === null) return {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsedLegacy));
      return parsedLegacy;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function savePolicy(policy) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(policy));
}

/**
 * Get the trust tier for a peer by user ID.
 * @param {number|string} userId
 * @returns {'manual'|'allow'|'deny'}
 */
export function getTrust(userId) {
  const policy = loadPolicy();
  const tier = policy[String(userId)];
  return VALID_TIERS.includes(tier) ? tier : 'manual';
}

/**
 * Persist a trust tier for a peer.
 * @param {number|string} userId
 * @param {'manual'|'allow'|'deny'} tier
 */
export function setTrust(userId, tier) {
  if (!VALID_TIERS.includes(tier)) throw new Error(`Invalid trust tier: ${tier}`);
  const policy = loadPolicy();
  policy[String(userId)] = tier;
  savePolicy(policy);
}

/**
 * Reset a peer's trust back to 'manual'.
 * @param {number|string} userId
 */
export function resetTrust(userId) {
  const policy = loadPolicy();
  delete policy[String(userId)];
  savePolicy(policy);
}

/**
 * Return a snapshot of all non-manual trust entries.
 * @returns {Record<string, 'allow'|'deny'>}
 */
export function listTrustOverrides() {
  const policy = loadPolicy();
  return Object.fromEntries(
    Object.entries(policy).filter(([, tier]) => tier !== 'manual')
  );
}
