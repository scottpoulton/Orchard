import React from "react";
import { TRANSFER_STATES } from "../transfer-queue.js";

function statusIcon(status) {
  switch (status) {
    case TRANSFER_STATES.DOWNLOADING: return "⬇️";
    case TRANSFER_STATES.RELAY: return "🔀";
    case TRANSFER_STATES.DIRECT: return "⚡";
    case TRANSFER_STATES.CONNECTING: return "🔗";
    case TRANSFER_STATES.REQUESTING: return "⏳";
    case TRANSFER_STATES.APPROVED: return "✅";
    case TRANSFER_STATES.QUEUED: return "📋";
    case TRANSFER_STATES.PAUSED: return "⏸️";
    case TRANSFER_STATES.STALLED: return "🟡";
    case TRANSFER_STATES.FAILED: return "❌";
    case TRANSFER_STATES.REJECTED: return "🚫";
    case TRANSFER_STATES.COMPLETED: return "✅";
    default: return "•";
  }
}

/** Format bytes/sec as a human-readable speed string (e.g. "1.2 MB/s"). */
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return null;
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** Format remaining seconds as a human-readable ETA string (e.g. "~2m 30s"). */
function formatEta(etaSec) {
  if (etaSec == null || etaSec <= 0) return null;
  if (etaSec < 60) return `~${etaSec}s`;
  const mins = Math.floor(etaSec / 60);
  const secs = etaSec % 60;
  return secs > 0 ? `~${mins}m ${secs}s` : `~${mins}m`;
}

export function TransferQueuePanel({ items, onResume, onPause, onPauseAll, onResumeAll, onMoveUp, onMoveDown, onReorder }) {
  if (!items || items.length === 0) return null;

  const hasActive = items.some((item) =>
    item.status === TRANSFER_STATES.DOWNLOADING ||
    item.status === TRANSFER_STATES.RELAY ||
    item.status === TRANSFER_STATES.REQUESTING
  );
  const hasPaused = items.some((item) =>
    item.status === TRANSFER_STATES.PAUSED ||
    item.status === TRANSFER_STATES.STALLED ||
    item.status === TRANSFER_STATES.FAILED
  );

  return (
    <div className="transfer-queue-panel">
      <div className="transfer-queue-header">
        <strong>Transfer Queue ({items.length})</strong>
        <div className="transfer-queue-bulk-actions">
          {hasActive && onPauseAll && (
            <button className="btn-queue-bulk" onClick={onPauseAll} title="Pause all active transfers">
              ⏸ Pause All
            </button>
          )}
          {hasPaused && onResumeAll && (
            <button className="btn-queue-bulk" onClick={onResumeAll} title="Resume all paused/stalled transfers">
              ▶ Resume All
            </button>
          )}
        </div>
      </div>
      <ul className="transfer-queue-list">
        {items.map((item) => {
          const pct = item.total > 0 ? Math.round((item.loaded / item.total) * 100) : 0;
          const sizeMb = item.total > 0 ? `${(item.total / (1024 * 1024)).toFixed(1)} MB` : "";
          const connType =
            item.status === TRANSFER_STATES.RELAY
              ? "🔀 relay"
              : item.status === TRANSFER_STATES.DIRECT || item.status === TRANSFER_STATES.DOWNLOADING
              ? "⚡ direct"
              : "";
          const isActive =
            item.status === TRANSFER_STATES.DOWNLOADING ||
            item.status === TRANSFER_STATES.REQUESTING ||
            item.status === TRANSFER_STATES.RELAY;
          const isResumable =
            item.status === TRANSFER_STATES.PAUSED ||
            item.status === TRANSFER_STATES.FAILED ||
            item.status === TRANSFER_STATES.STALLED;
          const isQueued = item.status === TRANSFER_STATES.QUEUED;
          const speedLabel = isActive ? formatSpeed(item.speedBytesPerSec) : null;
          const etaLabel = isActive ? formatEta(item.etaSec) : null;
          return (
            <li
              key={item.id}
              className={`transfer-queue-item status-${item.status}`}
              draggable={isQueued && !!onReorder}
              onDragStart={(event) => {
                if (!isQueued || !onReorder) return;
                event.dataTransfer.setData("text/plain", item.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (!isQueued || !onReorder) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                if (!isQueued || !onReorder) return;
                event.preventDefault();
                const sourceId = event.dataTransfer.getData("text/plain");
                if (!sourceId || sourceId === item.id) return;
                onReorder(sourceId, item.id);
              }}
              title={isQueued && onReorder ? "Drag to reprioritize queued transfers" : undefined}
            >
              <div className="transfer-queue-item-info">
                <span className="transfer-status-icon">{statusIcon(item.status)}</span>
                <div className="transfer-queue-item-details">
                  <span className="transfer-queue-filename">
                    <strong>{item.fileName}</strong>
                    {item.ownerUsername ? <span className="transfer-from"> ← {item.ownerUsername}</span> : ""}
                  </span>
                  <div className="transfer-queue-meta">
                    <span className={`transfer-status-pill status-${item.status}`}>{item.status}</span>
                    {connType && <span className="conn-type-pill">{connType}</span>}
                    {item.total > 0 &&
                      item.status !== TRANSFER_STATES.QUEUED &&
                      item.status !== TRANSFER_STATES.REQUESTING && (
                        <span className="transfer-progress-inline">
                          {pct}%{sizeMb && ` / ${sizeMb}`}
                        </span>
                      )}
                    {speedLabel && (
                      <span className="transfer-speed">{speedLabel}</span>
                    )}
                    {etaLabel && (
                      <span className="transfer-eta">{etaLabel}</span>
                    )}
                    {item.retries > 0 && (
                      <span className="transfer-retries" title="Retry count">retry #{item.retries}</span>
                    )}
                    {item.error && (
                      <span className="transfer-error" title={item.error}> ⚠ {item.error}</span>
                    )}
                  </div>
                  {item.total > 0 && isActive && (
                    <div className="transfer-queue-progress-bar-wrap">
                      <div
                        className="transfer-queue-progress-bar"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="transfer-queue-item-actions">
                {isQueued && onMoveUp && (
                  <button className="btn-queue-action" onClick={() => onMoveUp(item.id)} title="Prioritize up">↑</button>
                )}
                {isQueued && onMoveDown && (
                  <button className="btn-queue-action" onClick={() => onMoveDown(item.id)} title="Prioritize down">↓</button>
                )}
                {isResumable && (
                  <button className="btn-queue-action" onClick={() => onResume(item.id)} title="Resume">▶</button>
                )}
                {isActive && (
                  <button className="btn-queue-action" onClick={() => onPause(item.id)} title="Pause">⏸</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
