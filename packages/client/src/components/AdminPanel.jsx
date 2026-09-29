import React, { useState, useEffect } from "react";
import { config } from "../config.js";

export function AdminPanel({ isOpen, onClose, token }) {
  const [tab, setTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const loadUsers = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${config.serverUrl}/admin/users`, { headers });
      if (r.ok) setUsers(await r.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const loadAudit = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${config.serverUrl}/admin/audit`, { headers });
      if (r.ok) setAuditLogs(await r.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const loadSessions = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${config.serverUrl}/admin/sessions`, { headers });
      if (r.ok) setSessions(await r.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!isOpen) return;
    if (tab === "users") loadUsers();
    else if (tab === "audit") loadAudit();
    else if (tab === "sessions") loadSessions();
  }, [isOpen, tab]);

  const toggleEnabled = async (user) => {
    try {
      const r = await fetch(`${config.serverUrl}/admin/users/${user.id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ enabled: !user.enabled }),
      });
      if (r.ok) {
        const updated = await r.json();
        setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));
        setMsg(`${updated.username} ${updated.enabled ? "enabled" : "disabled"}`);
        setTimeout(() => setMsg(""), 2000);
      }
    } catch { /* ignore */ }
  };

  const setRole = async (user, role) => {
    try {
      const r = await fetch(`${config.serverUrl}/admin/users/${user.id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ role }),
      });
      if (r.ok) {
        const updated = await r.json();
        setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));
        setMsg(`${updated.username} is now ${updated.role}`);
        setTimeout(() => setMsg(""), 2000);
      }
    } catch { /* ignore */ }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content admin-panel">
        <h2>🛡️ Admin Panel</h2>
        <div className="admin-tabs">
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>👥 Users</button>
          <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>📋 Audit Log</button>
          <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>🌐 Sessions</button>
        </div>

        {loading && <p className="admin-loading">Loading…</p>}
        {msg && <p className="admin-msg">{msg}</p>}

        {tab === "users" && !loading && (
          <table className="admin-table">
            <thead>
              <tr><th>Username</th><th>Role</th><th>Enabled</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.role}</td>
                  <td>{u.enabled ? "✅" : "❌"}</td>
                  <td>
                    <button onClick={() => toggleEnabled(u)}>
                      {u.enabled ? "Disable" : "Enable"}
                    </button>
                    {u.role !== "admin" && (
                      <button onClick={() => setRole(u, "admin")}>Make Admin</button>
                    )}
                    {u.role === "admin" && (
                      <button onClick={() => setRole(u, "user")}>Remove Admin</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "audit" && !loading && (
          <table className="admin-table">
            <thead>
              <tr><th>Time</th><th>Action</th><th>UserId</th><th>TargetId</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {auditLogs.map((l) => (
                <tr key={l.id}>
                  <td>{new Date(l.createdAt).toLocaleString()}</td>
                  <td>{l.action}</td>
                  <td>{l.userId || "—"}</td>
                  <td>{l.targetUserId || "—"}</td>
                  <td className="audit-detail">{l.detail || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "sessions" && !loading && (
          <table className="admin-table">
            <thead>
              <tr><th>Username</th><th>Connected</th><th>Last Ping</th></tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>{s.username}</td>
                  <td>{new Date(s.connectedAt).toLocaleTimeString()}</td>
                  <td>{s.lastPingAt ? new Date(s.lastPingAt).toLocaleTimeString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="modal-actions">
          <button onClick={onClose} className="btn-primary">Close</button>
        </div>
      </div>
    </div>
  );
}
