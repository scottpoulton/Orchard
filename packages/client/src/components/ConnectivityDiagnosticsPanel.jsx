import React, { useMemo } from "react";

function formatTime(iso) {
  if (!iso) return "unknown";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return "unknown";
  }
}

function statusClass(status = "") {
  if (status.includes("success")) return "ok";
  if (status.includes("failed")) return "bad";
  if (status.includes("start")) return "warn";
  return "neutral";
}

export function ConnectivityDiagnosticsPanel({ connectivityInfo, transferDiagnostics = [] }) {
  const natStrategy = connectivityInfo?.nat?.strategy || "unknown";
  const localHost = connectivityInfo?.host;
  const localPort = connectivityInfo?.port || 5555;
  const summary = useMemo(() => {
    const total = transferDiagnostics.length;
    const directSuccess = transferDiagnostics.filter((d) => d.status?.includes("direct:success")).length;
    const relaySuccess = transferDiagnostics.filter((d) => d.status?.includes("relay:success")).length;
    const directFailed = transferDiagnostics.filter((d) => d.status?.includes("direct:failed")).length;
    const relayFailed = transferDiagnostics.filter((d) => d.status?.includes("relay:failed")).length;
    return { total, directSuccess, relaySuccess, directFailed, relayFailed };
  }, [transferDiagnostics]);

  const shouldShowTrustProxyHint =
    natStrategy === "relay-fallback" &&
    summary.directFailed > 0;
  const shouldShowRouterGuidance =
    natStrategy === "relay-fallback" &&
    summary.directFailed > 0 &&
    summary.directSuccess === 0;
  const shouldShowRelayFailureGuidance = summary.relayFailed > 0;

  return (
    <div className="connectivity-diagnostics">
      <h4>Connectivity Diagnostics</h4>
      <div className="diag-summary-row">
        <span className="diag-chip">direct ok: {summary.directSuccess}</span>
        <span className="diag-chip">relay ok: {summary.relaySuccess}</span>
        <span className="diag-chip">direct fail: {summary.directFailed}</span>
        <span className="diag-chip">relay fail: {summary.relayFailed}</span>
      </div>

      {shouldShowTrustProxyHint && (
        <div className="diag-guidance warn">
          <p>
            <strong>Broker behind Caddy/NGINX?</strong>
          </p>
          <p>
            Set <code className="endpoint-code">TRUST_PROXY=1</code> on the broker and restart.
            This allows public IP fallback to use <code className="endpoint-code">X-Forwarded-For</code>.
          </p>
        </div>
      )}

      {natStrategy === "relay-fallback" && (
        <div className="diag-guidance">
          You are currently in relay mode. Try router port-forwarding for your file server port if you want direct transfers.
        </div>
      )}
      {shouldShowRouterGuidance && (
        <div className="diag-guidance warn">
          <p>
            <strong>Direct path still failing? Quick checklist:</strong>
          </p>
          <ul>
            <li>
              Forward <code className="endpoint-code">TCP {localPort}</code> to{" "}
              <code className="endpoint-code">{localHost || "this device"}:{localPort}</code> on your router.
            </li>
            <li>
              Restart Orchard and retry one transfer to confirm direct path recovery.
            </li>
            <li>
              If forwarding still fails, your ISP may be using CGNAT. Relay mode is expected in that case.
            </li>
          </ul>
        </div>
      )}
      {shouldShowRelayFailureGuidance && (
        <div className="diag-guidance warn">
          <p>
            <strong>Relay transfer failures detected.</strong> Check broker reachability/capacity and confirm both peers stay online during transfer.
          </p>
        </div>
      )}

      <ul className="diag-list">
        {transferDiagnostics.length === 0 ? (
          <li className="diag-empty">No transfer diagnostics yet.</li>
        ) : (
          transferDiagnostics.slice(0, 8).map((entry) => (
            <li key={entry.id} className={`diag-item ${statusClass(entry.status)}`}>
              <span className="diag-time">{formatTime(entry.at)}</span>
              <code>{entry.transferId}</code>
              <strong>{entry.status}</strong>
              <span>{entry.reason}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
