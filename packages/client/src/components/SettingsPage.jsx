import React, { useState } from "react";
import {
  DEFAULT_GLOBAL_BYTES_PER_SECOND,
  DEFAULT_PEER_BYTES_PER_SECOND,
} from "../transfer-queue.js";
import { ConnectivityDiagnosticsPanel } from "./ConnectivityDiagnosticsPanel.jsx";
import { loadServerUrl, saveServerUrl, compiledServerUrl } from "../config.js";

const BANDWIDTH_STORAGE_KEY = "orchard.bandwidth.v1";
const LEGACY_BANDWIDTH_STORAGE_KEY = "sanctumshare.bandwidth.v1";

/** Heuristic: replace the last octet with .1 to guess the router address (works for most /24 home LANs). */
function guessGateway(localHost) {
  if (!localHost) return '192.168.x.1';
  const parts = localHost.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
  return '192.168.x.1';
}

function kbps(bytesPerSec) {
  return Math.round(bytesPerSec / 1024);
}

function bytesFromKbps(kb) {
  return Math.max(32 * 1024, Number(kb) * 1024);
}

export function loadBandwidthSettings() {
  try {
    const raw = localStorage.getItem(BANDWIDTH_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const legacyRaw = localStorage.getItem(LEGACY_BANDWIDTH_STORAGE_KEY);
    if (!legacyRaw) return null;
    const parsedLegacy = JSON.parse(legacyRaw);
    localStorage.setItem(BANDWIDTH_STORAGE_KEY, JSON.stringify(parsedLegacy));
    return parsedLegacy;
  } catch {
    return null;
  }
}

function saveBandwidthSettings(settings) {
  try {
    localStorage.setItem(BANDWIDTH_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export function SettingsPage({
  isOpen,
  onClose,
  sharedFolder,
  onChangeFolder,
  onStopSharing,
  connectivityInfo,
  transferDiagnostics,
  bandwidthSettings,
  onBandwidthChange,
}) {
  const [globalKbps, setGlobalKbps] = useState(
    () => kbps(bandwidthSettings?.globalBytesPerSecond ?? DEFAULT_GLOBAL_BYTES_PER_SECOND)
  );
  const [peerKbps, setPeerKbps] = useState(
    () => kbps(bandwidthSettings?.peerBytesPerSecond ?? DEFAULT_PEER_BYTES_PER_SECOND)
  );
  const [maxActive, setMaxActive] = useState(
    () => bandwidthSettings?.maxActive ?? 1
  );
  const [bwSaved, setBwSaved] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState(() => loadServerUrl());
  const [serverUrlSaved, setServerUrlSaved] = useState(false);
  const [serverUrlError, setServerUrlError] = useState("");

  if (!isOpen) return null;

  const nat = connectivityInfo?.nat;
  const localHost = connectivityInfo?.host;
  const localPort = connectivityInfo?.port;

  let natBadge = null;
  let natDetails = null;
  if (nat) {
    if (nat.strategy === 'upnp-assist') {
      natBadge = <span className="nat-badge nat-ok">🟢 UPnP Active</span>;
      natDetails = (
        <p>
          External address: <code className="endpoint-code">{nat.externalHost}:{nat.externalPort}</code>.{' '}
          Direct P2P transfers are enabled.
        </p>
      );
    } else if (nat.strategy === 'nat-pmp') {
      natBadge = <span className="nat-badge nat-ok">🟢 NAT-PMP Active</span>;
      natDetails = (
        <p>
          External port: <code className="endpoint-code">{nat.externalPort}</code>.{' '}
          Direct P2P transfers are enabled.
        </p>
      );
    } else if (nat.strategy === 'relay-fallback') {
      const gatewayGuess = guessGateway(localHost);
      natBadge = <span className="nat-badge nat-warn">🟡 Relay Mode</span>;
      natDetails = (
        <>
          <p>Automatic port mapping (UPnP / NAT-PMP) was not available. File transfers use the broker relay, which is slower and may be capacity-limited.</p>
          <p><strong>To enable direct P2P transfers, forward a port on your router:</strong></p>
          <ol className="port-forward-steps">
            <li>Log in to your router — usually at <code className="endpoint-code">{gatewayGuess}</code></li>
            <li>Add a port-forwarding rule: <strong>TCP {localPort || 5555}</strong> → <code className="endpoint-code">{localHost}:{localPort || 5555}</code></li>
            <li>Restart Orchard so it can re-attempt UPnP with the new mapping</li>
          </ol>
          <p>
            If your broker is behind Caddy/Nginx, set <code className="endpoint-code">TRUST_PROXY=1</code> on the broker and restart it.
          </p>
          <p>
            Verify broker public-IP visibility by opening <code className="endpoint-code">https://your-broker-url/api/my-ip</code> from this client network.
          </p>
          <p className="nat-note"><em>Note: Some ISPs use Carrier-Grade NAT (CGNAT). If port forwarding does not work, your ISP may need to assign you a static public IP.</em></p>
        </>
      );
    } else {
      natBadge = <span className="nat-badge nat-unknown">⚪ Detecting…</span>;
    }
  }

  const handleBandwidthSave = () => {
    const settings = {
      globalBytesPerSecond: bytesFromKbps(globalKbps),
      peerBytesPerSecond: bytesFromKbps(peerKbps),
      maxActive: Math.max(1, Math.min(5, Number(maxActive) || 1)),
    };
    saveBandwidthSettings(settings);
    onBandwidthChange?.(settings);
    setBwSaved(true);
    setTimeout(() => setBwSaved(false), 2000);
  };

  const handleServerUrlSave = () => {
    const trimmed = serverUrlInput.trim();
    if (!trimmed || !/^https?:\/\//.test(trimmed)) {
      setServerUrlError("URL must start with http:// or https://");
      return;
    }
    setServerUrlError("");
    saveServerUrl(trimmed);
    setServerUrlSaved(true);
    setTimeout(() => setServerUrlSaved(false), 4000);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content settings-page">
        <h2>⚙️ Settings</h2>
        <div className="settings-section">
          <h3>Shared Folder</h3>
          {sharedFolder ? (
            <div className="folder-info">
              <p className="folder-path">{sharedFolder}</p>
              <div className="folder-actions">
                <button onClick={onChangeFolder} className="btn-primary">📁 Change Folder</button>
                <button onClick={onStopSharing} className="btn-danger">🛑 Stop Sharing</button>
              </div>
            </div>
          ) : (
            <div className="no-folder">
              <p>No folder currently shared</p>
              <button onClick={onChangeFolder} className="btn-primary">📁 Select Folder</button>
            </div>
          )}
        </div>

        <div className="settings-section">
          <h3>🔗 Broker Server URL</h3>
          <p className="settings-description">
            The broker server your client connects to. Changing this takes effect on the next app launch.
            {compiledServerUrl !== serverUrlInput && (
              <> Default built-in URL: <code className="endpoint-code">{compiledServerUrl}</code></>
            )}
          </p>
          <div className="bandwidth-controls">
            <label className="bandwidth-label">
              Server URL
              <input
                type="url"
                value={serverUrlInput}
                onChange={(e) => { setServerUrlInput(e.target.value); setServerUrlError(""); }}
                className="bandwidth-input"
                placeholder="https://your-broker-domain.example.com"
              />
            </label>
            {serverUrlError && <p className="settings-error">{serverUrlError}</p>}
            <div className="folder-actions">
              <button onClick={handleServerUrlSave} className="btn-primary">
                {serverUrlSaved ? '✅ Saved — restart app to reconnect' : 'Save Server URL'}
              </button>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>⚡ Bandwidth Throttle</h3>
          <div className="bandwidth-controls">
            <label className="bandwidth-label">
              Global download limit (KB/s)
              <input
                type="number"
                min={32}
                max={102400}
                value={globalKbps}
                onChange={(e) => setGlobalKbps(e.target.value)}
                className="bandwidth-input"
              />
            </label>
            <label className="bandwidth-label">
              Per-peer limit (KB/s)
              <input
                type="number"
                min={32}
                max={102400}
                value={peerKbps}
                onChange={(e) => setPeerKbps(e.target.value)}
                className="bandwidth-input"
              />
            </label>
            <label className="bandwidth-label">
              Max concurrent downloads
              <input
                type="number"
                min={1}
                max={5}
                value={maxActive}
                onChange={(e) => setMaxActive(e.target.value)}
                className="bandwidth-input bandwidth-input-sm"
              />
            </label>
            <div className="folder-actions">
              <button onClick={handleBandwidthSave} className="btn-primary">
                {bwSaved ? '✅ Saved' : 'Save Bandwidth Settings'}
              </button>
            </div>
          </div>
        </div>

        {connectivityInfo && (
          <div className="settings-section">
            <h3>🌐 Network Connectivity</h3>
            <div className="connectivity-status">
              <div className="nat-status-row">
                {natBadge}
                {localHost && localPort && (
                  <span className="local-endpoint">Local: <code className="endpoint-code">{localHost}:{localPort}</code></span>
                )}
              </div>
              <div className="nat-details">{natDetails}</div>
              <ConnectivityDiagnosticsPanel
                connectivityInfo={connectivityInfo}
                transferDiagnostics={transferDiagnostics}
              />
            </div>
          </div>
        )}
        <div className="settings-info">
          <h3>ℹ️ About Folder Monitoring</h3>
          <p>
            Orchard automatically monitors your shared folder for changes. When you add, modify, or
            delete files, the file list updates automatically.
          </p>
        </div>
        <div className="modal-actions">
          <button onClick={onClose} className="btn-primary">Close</button>
        </div>
      </div>
    </div>
  );
}
