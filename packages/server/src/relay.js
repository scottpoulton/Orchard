'use strict';

/**
 * Socket.IO handlers for the broker relay flow:
 *   RELAY_REQUEST → RELAY_SERVE → RELAY_CHUNK → RELAY_CHUNK_FWD → RELAY_END → RELAY_DONE
 */

const { EVENTS, validateMessage } = require('../../shared/protocol');
const MAX_ACTIVE_RELAY_SESSIONS = Number(process.env.MAX_ACTIVE_RELAY_SESSIONS || 200);
const MAX_RELAY_CHUNK_BYTES = Number(process.env.MAX_RELAY_CHUNK_BYTES || (1024 * 1024));
const MAX_RELAY_SESSIONS_PER_SOCKET = Number(process.env.MAX_RELAY_SESSIONS_PER_SOCKET || 20);

function estimateChunkBytes(data) {
  if (!data) return 0;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.length;
  if (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) return data.byteLength;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return data.byteLength;
  // For base64 strings, decoded bytes are approximately (encodedLength * 3) / 4.
  if (typeof data === 'string') {
    return Math.ceil((data.length * 3) / 4);
  }
  return 0;
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {{ io, getSessionBySocketId, getOnlineSessions, relaySessions, setRelaySession, deleteRelaySession, getRelayCountForSocket,
 *            enforceSocketRateLimit, logLifecycleDebug }} services
 */
function attachRelayHandlers(socket, {
  io,
  getSessionBySocketId,
  getOnlineSessions,
  relaySessions,
  setRelaySession,
  deleteRelaySession,
  getRelayCountForSocket,
  enforceSocketRateLimit,
  logLifecycleDebug,
}) {
  // RELAY_REQUEST: requester asks broker to relay a file
  socket.on(EVENTS.RELAY_REQUEST, (payload = {}) => {
    if (!enforceSocketRateLimit(socket, EVENTS.RELAY_REQUEST)) return;
    const check = validateMessage(EVENTS.RELAY_REQUEST, payload);
    if (!check.valid) {
      socket.emit(EVENTS.RELAY_DONE, { relayId: payload?.relayId || '', error: check.error });
      return;
    }
    if (relaySessions.size >= MAX_ACTIVE_RELAY_SESSIONS) {
      socket.emit(EVENTS.RELAY_DONE, { relayId: payload.relayId, error: 'Relay capacity reached' });
      return;
    }
    if (getRelayCountForSocket(socket.id) >= MAX_RELAY_SESSIONS_PER_SOCKET) {
      socket.emit(EVENTS.RELAY_DONE, { relayId: payload.relayId, error: 'Too many concurrent relay sessions' });
      return;
    }
    const requester = getSessionBySocketId(socket.id);
    if (!requester || !requester.user) {
      socket.emit(EVENTS.RELAY_DONE, { relayId: payload.relayId, error: 'Not authenticated' });
      return;
    }
    const ownerSession = getOnlineSessions().find((s) => s.user.id === payload.ownerId);
    if (!ownerSession) {
      socket.emit(EVENTS.RELAY_DONE, { relayId: payload.relayId, error: 'Owner not online' });
      return;
    }
    setRelaySession(payload.relayId, {
      requesterSocketId: socket.id,
      ownerSocketId: ownerSession.socketId,
      transferId: payload.transferId || null,
      createdAt: Date.now(),
    });
    io.to(ownerSession.socketId).emit(EVENTS.RELAY_SERVE, {
      relayId: payload.relayId,
      filePath: payload.filePath,
      byteOffset: Number(payload.byteOffset || 0),
      requesterUsername: requester.user.username,
    });
    logLifecycleDebug('relay:request', 'CONNECTED', requester, {
      socketId: socket.id,
      reason: `relayId=${payload.relayId} filePath=${payload.filePath}`,
    });
  });

  // RELAY_CHUNK: owner sends a chunk, broker forwards to requester
  socket.on(EVENTS.RELAY_CHUNK, (payload = {}) => {
    if (!enforceSocketRateLimit(socket, EVENTS.RELAY_CHUNK)) return;
    const check = validateMessage(EVENTS.RELAY_CHUNK, payload);
    if (!check.valid) return;
    const session = relaySessions.get(payload.relayId);
    if (!session || session.ownerSocketId !== socket.id) return;
    const estimatedChunkSize = estimateChunkBytes(payload.data);
    if (estimatedChunkSize <= 0 || estimatedChunkSize > MAX_RELAY_CHUNK_BYTES) {
      io.to(session.requesterSocketId).emit(EVENTS.RELAY_DONE, {
        relayId: payload.relayId,
        error: 'Invalid relay chunk',
      });
      deleteRelaySession(payload.relayId);
      return;
    }
    io.to(session.requesterSocketId).emit(EVENTS.RELAY_CHUNK_FWD, {
      relayId: payload.relayId,
      data: payload.data,
      offset: payload.offset,
    });
  });

  // RELAY_END: owner signals completion or error
  socket.on(EVENTS.RELAY_END, (payload = {}) => {
    if (!enforceSocketRateLimit(socket, EVENTS.RELAY_END)) return;
    const check = validateMessage(EVENTS.RELAY_END, payload);
    if (!check.valid) return;
    const session = relaySessions.get(payload.relayId);
    if (!session || session.ownerSocketId !== socket.id) return;
    deleteRelaySession(payload.relayId);
    io.to(session.requesterSocketId).emit(EVENTS.RELAY_DONE, {
      relayId: payload.relayId,
      error: payload.error || null,
      fileName: payload.fileName,
      totalBytes: payload.totalBytes,
    });
    logLifecycleDebug('relay:end', 'CONNECTED', getSessionBySocketId(socket.id) || {}, {
      socketId: socket.id,
      reason: `relayId=${payload.relayId} error=${payload.error || 'none'}`,
    });
  });
}

module.exports = { attachRelayHandlers };
