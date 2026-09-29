'use strict';

/**
 * Shared in-process state for the broker.
 *
 * Centralises all mutable Maps and the EventEmitter so individual
 * route/handler modules can be injected with the same state objects
 * rather than importing globals.
 */

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { HEARTBEAT, HEARTBEAT_TIMEOUT_REASON } = require('../../shared/protocol');

/**
 * Create and return a fresh state container.
 * Call once per server lifetime (or once per test run).
 *
 * @param {{ prisma: import('@prisma/client').PrismaClient, io: import('socket.io').Server, logLifecycle: Function, logLifecycleDebug: Function }} services
 */
function createState({ prisma, io, logLifecycle, logLifecycleDebug }) {
  // sessionKey (clientId:sessionId) => session object
  const sessions = new Map();
  // socket.id => sessionKey
  const socketToSession = new Map();
  // clientId => sessionKey
  const clientToSession = new Map();
  // requestId => pending file-send request
  const pendingFileSendRequests = new Map();
  // relayId => relay session
  const relaySessions = new Map();
  // socket.id => number of active relay sessions
  const socketRelaySessionCounts = new Map();

  const brokerEvents = new EventEmitter();

  const PENDING_FILE_SEND_TTL_MS = 5 * 60 * 1000; // 5 min
  const RELAY_SESSION_TTL_MS = 10 * 60 * 1000; // 10 min

  function makeSessionKey(clientId, sessionId) {
    return `${clientId}:${sessionId}`;
  }

  function getSessionBySocketId(socketId) {
    const key = socketToSession.get(socketId);
    return key ? sessions.get(key) : null;
  }

  function getOnlineSessions() {
    return Array.from(sessions.values()).filter((s) => !!s.socketId && !!s.user);
  }

  async function notifyBuddiesUserOffline(session) {
    if (!session?.user) return;
    const rows = await prisma.buddy.findMany({
      where: { buddyId: session.user.id },
      select: { userId: true },
    });
    const buddyUserIds = new Set(rows.map((b) => b.userId));
    for (const online of getOnlineSessions()) {
      if (buddyUserIds.has(online.user.id)) {
        io.to(online.socketId).emit('user:offline', session.user);
      }
    }
  }

  async function markSessionOffline(session, reason, opts = {}) {
    if (!session) return;
    const socketId = opts.socketId ?? session.socketId;
    logLifecycle('session:offline', 'OFFLINE', session, { reason, socketId });
    if (socketId) socketToSession.delete(socketId);
    session.socketId = null;
    session.disconnectedAt = Date.now();
    brokerEvents.emit('peer:offline', {
      clientId: session.clientId,
      sessionId: session.sessionId,
      userId: session.user?.id || null,
      reason,
    });
    await notifyBuddiesUserOffline(session);
  }

  function incrementRelayCountForSocket(socketId) {
    if (!socketId) return;
    socketRelaySessionCounts.set(socketId, (socketRelaySessionCounts.get(socketId) || 0) + 1);
  }

  function decrementRelayCountForSocket(socketId) {
    if (!socketId) return;
    const next = (socketRelaySessionCounts.get(socketId) || 0) - 1;
    if (next <= 0) socketRelaySessionCounts.delete(socketId);
    else socketRelaySessionCounts.set(socketId, next);
  }

  function setRelaySession(relayId, value) {
    const existing = relaySessions.get(relayId);
    if (existing) {
      decrementRelayCountForSocket(existing.requesterSocketId);
      decrementRelayCountForSocket(existing.ownerSocketId);
    }
    relaySessions.set(relayId, value);
    incrementRelayCountForSocket(value.requesterSocketId);
    incrementRelayCountForSocket(value.ownerSocketId);
  }

  function deleteRelaySession(relayId) {
    const existing = relaySessions.get(relayId);
    if (!existing) return false;
    relaySessions.delete(relayId);
    decrementRelayCountForSocket(existing.requesterSocketId);
    decrementRelayCountForSocket(existing.ownerSocketId);
    return true;
  }

  function getRelayCountForSocket(socketId) {
    return socketRelaySessionCounts.get(socketId) || 0;
  }

  // ── Sweeper: cleans stale sessions and TTL-expired pending requests ──────
  const staleSessionSweeper = setInterval(async () => {
    try {
    const now = Date.now();
    for (const [key, session] of Array.from(sessions.entries())) {
      if (session.socketId) {
        const lastSeen = session.lastPingAt ?? session.connectedAt;
        if (now - lastSeen > HEARTBEAT.TIMEOUT_MS) {
          const staleSocketId = session.socketId;
          await markSessionOffline(session, HEARTBEAT_TIMEOUT_REASON, { socketId: staleSocketId });
          sessions.delete(key);
          if (clientToSession.get(session.clientId) === key) clientToSession.delete(session.clientId);
          const staleSocket = io.sockets.sockets.get(staleSocketId);
          if (staleSocket) staleSocket.disconnect(true);
        }
      }
      if (session.disconnectedAt && now - session.disconnectedAt > HEARTBEAT.DISCONNECTED_CLEANUP_MS) {
        sessions.delete(key);
        if (clientToSession.get(session.clientId) === key) clientToSession.delete(session.clientId);
      }
    }
    } catch (err) {
      console.error('[Sweeper] Stale session sweep error:', err);
    }
  }, HEARTBEAT.SWEEP_INTERVAL_MS);
  staleSessionSweeper.unref();

  const pendingRequestSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, req] of pendingFileSendRequests.entries()) {
      if (now - req.createdAt > PENDING_FILE_SEND_TTL_MS) {
        pendingFileSendRequests.delete(id);
        // Notify the sender that their file-send request was never answered.
        const senderSocket = io.sockets.sockets.get(req.senderSocketId);
        if (senderSocket) {
          senderSocket.emit('file:send:rejected', {
            requestId: id,
            fileName: req.fileName,
            message: 'File send request expired (recipient did not respond in time)',
          });
        }
      }
    }
    for (const [id, s] of relaySessions.entries()) {
      if (now - s.createdAt > RELAY_SESSION_TTL_MS) deleteRelaySession(id);
    }
  }, 60_000);
  pendingRequestSweeper.unref();

  function clearSweepers() {
    clearInterval(staleSessionSweeper);
    clearInterval(pendingRequestSweeper);
  }

  return {
    sessions,
    socketToSession,
    clientToSession,
    pendingFileSendRequests,
    relaySessions,
    setRelaySession,
    deleteRelaySession,
    getRelayCountForSocket,
    brokerEvents,
    makeSessionKey,
    getSessionBySocketId,
    getOnlineSessions,
    markSessionOffline,
    clearSweepers,
    randomUUID,
  };
}

module.exports = { createState };
