// Configuration for the Orchard client

const SERVER_URL_STORAGE_KEY = 'orchard.serverUrl.v1';
const LEGACY_SERVER_URL_STORAGE_KEY = 'sanctumshare.serverUrl.v1';

/** The broker URL baked in at build time via VITE_SERVER_URL. */
export const compiledServerUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

/**
 * Return the active broker URL.
 * Prefers the value saved in localStorage (from the Settings page) over the
 * compile-time default, so users can point the app at a different server
 * without needing a new build.
 */
export function loadServerUrl() {
  try {
    const stored = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    if (stored && /^https?:\/\//.test(stored.trim())) return stored.trim();
    const legacyStored = localStorage.getItem(LEGACY_SERVER_URL_STORAGE_KEY);
    if (legacyStored && /^https?:\/\//.test(legacyStored.trim())) {
      localStorage.setItem(SERVER_URL_STORAGE_KEY, legacyStored.trim());
      return legacyStored.trim();
    }
  } catch {
    // localStorage unavailable (e.g. during SSR/testing) — fall through
  }
  return compiledServerUrl;
}

/**
 * Persist a new broker URL to localStorage.
 * The change takes effect the next time the app launches (or reconnects).
 */
export function saveServerUrl(url) {
  try {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, url.trim());
  } catch {
    // ignore
  }
}

export const config = {
  // Resolved at startup: localStorage override → compile-time default.
  serverUrl: loadServerUrl(),

  // Dev server configuration
  devServerPort: import.meta.env.VITE_DEV_PORT || 5173,

  // Lifecycle observability toggle
  lifecycleDebug: import.meta.env.VITE_LIFECYCLE_DEBUG === 'true',
};
