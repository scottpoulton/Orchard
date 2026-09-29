import React, { useState, useEffect, useRef } from "react";
import { config } from "../config.js";
import { EVENTS } from "@shared/protocol.js";

/**
 * Messaging drawer: renders the conversation with a specific buddy,
 * and lets the user send new messages via Socket.IO.
 */
export function MessagingDrawer({ isOpen, onClose, peer, token, socket, currentUserId }) {
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const bottomRef = useRef(null);

  // Load history from REST on open
  useEffect(() => {
    if (!isOpen || !peer) return;
    fetch(`${config.serverUrl}/messages/${peer.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : [])
      .then(setMessages)
      .catch(() => {});
  }, [isOpen, peer]);

  // Listen for live messages
  useEffect(() => {
    if (!socket || !peer) return;
    const handler = (msg) => {
      if (
        (msg.senderId === peer.id && msg.recipientId === currentUserId) ||
        (msg.senderId === currentUserId && msg.recipientId === peer.id)
      ) {
        setMessages((prev) => [...prev, msg]);
      }
    };
    socket.on(EVENTS.MESSAGE_RECEIVE, handler);
    return () => socket.off(EVENTS.MESSAGE_RECEIVE, handler);
  }, [socket, peer, currentUserId]);

  // Auto-scroll
  useEffect(() => {
    if (isOpen) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  const handleSend = (e) => {
    e.preventDefault();
    if (!body.trim() || !socket?.connected) return;
    socket.emit(EVENTS.MESSAGE_SEND, { recipientId: peer.id, body: body.trim() });
    setBody("");
  };

  if (!isOpen || !peer) return null;

  return (
    <div className="messaging-drawer">
      <div className="messaging-header">
        <span>💬 {peer.username}</span>
        <button onClick={onClose} className="btn-close" title="Close">✕</button>
      </div>
      <div className="messaging-body">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`message-bubble ${m.senderId === currentUserId ? "mine" : "theirs"}`}
          >
            <span className="message-text">{m.body}</span>
            <span className="message-time">{new Date(m.createdAt).toLocaleTimeString()}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form className="messaging-input" onSubmit={handleSend}>
        <input
          type="text"
          placeholder="Type a message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={!body.trim()}>Send</button>
      </form>
    </div>
  );
}
