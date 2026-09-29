import React from "react";

export function ConfirmationDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  confirmText = "Approve",
  cancelText = "Reject",
  onAlwaysAllow,
  onAlwaysDeny,
}) {
  if (!isOpen) return null;
  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button onClick={onConfirm} className="btn-confirm">{confirmText}</button>
          <button onClick={onCancel} className="btn-cancel">{cancelText}</button>
          {onAlwaysAllow && (
            <button onClick={onAlwaysAllow} className="btn-always-allow" title="Approve now and always auto-approve this peer in future">
              Always Allow
            </button>
          )}
          {onAlwaysDeny && (
            <button onClick={onAlwaysDeny} className="btn-always-deny" title="Reject now and always auto-reject this peer in future">
              Always Deny
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
