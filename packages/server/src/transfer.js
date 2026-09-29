'use strict';

/**
 * Socket.IO handlers for the file-transfer flow:
 *   – SHARE_FILES / REFRESH_USERS
 *   – REQUEST_DOWNLOAD / DOWNLOAD_APPROVE / DOWNLOAD_REJECT
 *   – FILE_SEND / FILE_SEND_REQUEST / FILE_SEND_APPROVE / FILE_SEND_REJECT
 *   – CLIENT_INFO / TRANSFER_CONNECTIVITY_REPORT
 */

const { EVENTS, validateMessage } = require('../../shared/protocol');

/** Max size for FILE_SEND payload fileData (base64). 50 MB in base64 ≈ 68 M chars. */
const FILE_SEND_MAX_BASE64_BYTES = 68 * 1024 * 1024;
const FILE_SEND_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const FILE_SEND_MAX_SIZE_MB = Math.floor(FILE_SEND_MAX_SIZE_BYTES / (1024 * 1024));
const MAX_PENDING_FILE_SEND_REQUESTS = Number(process.env.MAX_PENDING_FILE_SEND_REQUESTS || 500);
const MAX_PENDING_FILE_SEND_PER_SOCKET = Number(process.env.MAX_PENDING_FILE_SEND_PER_SOCKET || 50);
const MAX_SHARED_ITEMS = Number(process.env.MAX_SHARED_ITEMS || 10_000);
const FILE_REF_RE = /^[a-f0-9]{16,64}$/i;

function countItems(tree, cap) {
  let count = 0;
  const stack = Array.isArray(tree) ? [...tree] : [];
  while (stack.length) {
    const item = stack.pop();
    count += 1;
    if (count > cap) return count;
    if (item && item.type === 'directory' && Array.isArray(item.children)) {
      for (const child of item.children) stack.push(child);
    }
  }
  return count;
}

function isValidSharedFileRef(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return FILE_REF_RE.test(trimmed);
}

function validateFileSendSize(socket, fileData, fileSize) {
  if (typeof fileData === 'string' && fileData.length > FILE_SEND_MAX_BASE64_BYTES) {
    socket.emit(EVENTS.DOWNLOAD_ERROR, { message: `File too large to send via broker relay (${FILE_SEND_MAX_SIZE_MB} MB limit)` });
    return false;
  }
  if (typeof fileSize === 'number' && fileSize > FILE_SEND_MAX_SIZE_BYTES) {
    socket.emit(EVENTS.DOWNLOAD_ERROR, { message: `File too large to send via broker relay (${FILE_SEND_MAX_SIZE_MB} MB limit)` });
    return false;
  }
  return true;
}

/**
 * Attach transfer-related socket event handlers to a connected socket.
 *
 * @param {import('socket.io').Socket} socket
 * @param {{ prisma, io, getSessionBySocketId, getOnlineSessions, pendingFileSendRequests,
 *            enforceSocketRateLimit, resolvePublicEndpoint, resolveOwnerDownloadEndpoint,
 *            logLifecycle, logLifecycleDebug, logAudit, randomUUID }} services
 */
function attachTransferHandlers(socket, {
  prisma,
  io,
  getSessionBySocketId,
  getOnlineSessions,
  pendingFileSendRequests,
  enforceSocketRateLimit,
  resolvePublicEndpoint,
  resolveOwnerDownloadEndpoint,
  logLifecycle,
  logLifecycleDebug,
  logAudit,
  randomUUID,
}) {
  // SHARE_FILES
  socket.on(EVENTS.SHARE_FILES, async (fileList) => {
    if (!enforceSocketRateLimit(socket, EVENTS.SHARE_FILES)) return;
    const check = validateMessage(EVENTS.SHARE_FILES, fileList);
    if (!check.valid) { console.warn(`[Socket.IO] Invalid message from ${socket.id}: ${check.error}`); return; }

    const totalItems = countItems(fileList, MAX_SHARED_ITEMS + 1);
    if (totalItems > MAX_SHARED_ITEMS) {
      socket.emit(EVENTS.ERROR, { code: 'SHARED_FILE_LIST_TOO_LARGE', message: 'Shared file list is too large' });
      return;
    }

    const clientData = getSessionBySocketId(socket.id);
    if (!clientData || !clientData.user) return;
    clientData.files = fileList;
    console.log(`[Socket.IO] ${clientData.user.username} is sharing ${fileList.length} items.`);

    try {
      const rows = await prisma.buddy.findMany({ where: { buddyId: clientData.user.id }, select: { userId: true } });
      const buddyUserIds = new Set(rows.map((b) => b.userId));
      for (const online of getOnlineSessions()) {
        if (buddyUserIds.has(online.user.id)) {
          io.to(online.socketId).emit(EVENTS.USER_UPDATED, {
            user: clientData.user,
            files: clientData.files,
            endpoints: clientData.endpoints,
            clientId: clientData.clientId,
          });
        }
      }
    } catch (err) {
      console.error(`[Socket.IO] SHARE_FILES broadcast error for ${clientData.user.username} (${socket.id}):`, err);
    }
  });

  // REFRESH_USERS
  socket.on(EVENTS.REFRESH_USERS, async () => {
    if (!enforceSocketRateLimit(socket, EVENTS.REFRESH_USERS)) return;
    const clientData = getSessionBySocketId(socket.id);
    if (!clientData || !clientData.user) return;
    try {
      const buddies = await prisma.buddy.findMany({ where: { userId: clientData.user.id }, select: { buddyId: true } });
      const buddyIds = new Set(buddies.map((b) => b.buddyId));
      const otherClients = getOnlineSessions()
        .filter((c) => c.user.id !== clientData.user.id && buddyIds.has(c.user.id))
        .map((c) => ({
          user: c.user,
          files: c.files,
          endpoints: c.endpoints,
          clientId: c.clientId,
        }));
      socket.emit(EVENTS.USERS_LIST, otherClients);
      console.log(`[Socket.IO] ${clientData.user.username} refreshed users list, now sees ${otherClients.length} buddies`);
    } catch (err) {
      console.error(`[Socket.IO] REFRESH_USERS error for ${clientData.user.username} (${socket.id}):`, err);
    }
  });

  // REQUEST_DOWNLOAD
  socket.on(EVENTS.REQUEST_DOWNLOAD, ({ fromUserId, filePath, fileName }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.REQUEST_DOWNLOAD)) return;
    const check = validateMessage(EVENTS.REQUEST_DOWNLOAD, { fromUserId, filePath });
    if (!check.valid) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Invalid download request' }); return; }
    if (!isValidSharedFileRef(filePath)) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Invalid file reference' }); return; }

    const targetSession = getOnlineSessions().find((s) => s.user.id === fromUserId);
    if (!targetSession) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'User not found or offline' }); return; }

    const requester = getSessionBySocketId(socket.id);
    if (!requester || !requester.user) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Requester not authenticated' }); return; }

    logAudit?.('download_request', requester.user.id, targetSession.user.id, `filePath=${filePath}`);
    io.to(targetSession.socketId).emit(EVENTS.DOWNLOAD_REQUEST, {
      requester: requester.user,
      filePath,
      fileName: payloadSafeFileName(fileName || filePath),
      requesterId: socket.id,
      requesterClientId: requester.clientId,
    });
  });

  // DOWNLOAD_APPROVE
  socket.on(EVENTS.DOWNLOAD_APPROVE, ({ requesterId, filePath, fileName, downloadToken }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.DOWNLOAD_APPROVE)) return;
    const check = validateMessage(EVENTS.DOWNLOAD_APPROVE, { requesterId, filePath });
    if (!check.valid) return;
    if (!isValidSharedFileRef(filePath)) return;
    const approver = getSessionBySocketId(socket.id);
    if (!approver || !approver.user) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Approver not authenticated' }); return; }
    const endpoint = resolveOwnerDownloadEndpoint(approver, socket);
    logAudit?.('download_approve', approver.user.id, null, `filePath=${filePath}`);
    io.to(requesterId).emit(EVENTS.DOWNLOAD_APPROVED, {
      filePath,
      fileName: payloadSafeFileName(fileName || filePath),
      ownerId: approver.user.id,
      ownerUsername: approver.user.username,
      ownerSocketId: socket.id,
      ownerHost: endpoint.ownerHost,
      port: endpoint.port,
      relayEligible: endpoint.relayEligible,
      // Forward the per-transfer download token issued by the owner's file server.
      // This allows the requester to authenticate for the direct HTTP download.
      downloadToken: (typeof downloadToken === 'string' && downloadToken.trim()) ? downloadToken.trim() : undefined,
    });
  });

  // DOWNLOAD_REJECT
  socket.on(EVENTS.DOWNLOAD_REJECT, ({ requesterId, filePath }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.DOWNLOAD_REJECT)) return;
    const check = validateMessage(EVENTS.DOWNLOAD_REJECT, { requesterId, filePath });
    if (!check.valid) return;
    const approver = getSessionBySocketId(socket.id);
    logAudit?.('download_reject', approver?.user?.id, null, `filePath=${filePath}`);
    io.to(requesterId).emit(EVENTS.DOWNLOAD_REJECTED, { filePath, ownerId: approver?.user?.id });
  });

  // FILE_SEND (legacy direct payload)
  socket.on(EVENTS.FILE_SEND, ({ recipientId, fileName, fileData, fileSize }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.FILE_SEND)) return;
    const check = validateMessage(EVENTS.FILE_SEND, { recipientId, fileName, fileData, fileSize });
    if (!check.valid) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Invalid file send request' }); return; }
    if (!validateFileSendSize(socket, fileData, fileSize)) return;
    const sender = getSessionBySocketId(socket.id);
    if (!sender) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Sender not found' }); return; }
    const recipientSession = getOnlineSessions().find((s) => s.user.id === recipientId);
    if (!recipientSession) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Recipient not online' }); return; }
    io.to(recipientSession.socketId).emit(EVENTS.FILE_INCOMING, {
      senderUsername: sender.user.username,
      fileName,
      fileData,
      fileSize,
    });
  });

  // FILE_SEND_REQUEST
  socket.on(EVENTS.FILE_SEND_REQUEST, ({ recipientId, fileName, fileData, fileSize }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.FILE_SEND_REQUEST)) return;
    const check = validateMessage(EVENTS.FILE_SEND_REQUEST, { recipientId, fileName, fileData, fileSize });
    if (!check.valid) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Invalid file send request' }); return; }
    if (!validateFileSendSize(socket, fileData, fileSize)) return;
    const sender = getSessionBySocketId(socket.id);
    if (!sender || !sender.user) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Sender not authenticated' }); return; }
    const recipientSession = getOnlineSessions().find((s) => s.user.id === recipientId);
    if (!recipientSession) { socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Recipient not online' }); return; }
    if (pendingFileSendRequests.size >= MAX_PENDING_FILE_SEND_REQUESTS) {
      socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Server busy, try again later' });
      return;
    }
    let senderPending = 0;
    for (const req of pendingFileSendRequests.values()) {
      if (req.senderSocketId === socket.id) senderPending += 1;
    }
    if (senderPending >= MAX_PENDING_FILE_SEND_PER_SOCKET) {
      socket.emit(EVENTS.DOWNLOAD_ERROR, { message: 'Too many pending file sends for this session' });
      return;
    }

    const requestId = randomUUID();
    pendingFileSendRequests.set(requestId, {
      id: requestId,
      senderSocketId: socket.id,
      recipientSocketId: recipientSession.socketId,
      senderUsername: sender.user.username,
      recipientId,
      fileName,
      fileData,
      fileSize,
      createdAt: Date.now(),
    });
    io.to(recipientSession.socketId).emit(EVENTS.FILE_SEND_REQUESTED, {
      requestId,
      senderUsername: sender.user.username,
      senderId: sender.user.id,
      senderClientId: sender.clientId,
      fileName,
      fileSize,
    });
  });

  // FILE_SEND_APPROVE
  socket.on(EVENTS.FILE_SEND_APPROVE, ({ requestId }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.FILE_SEND_APPROVE)) return;
    const check = validateMessage(EVENTS.FILE_SEND_APPROVE, { requestId });
    if (!check.valid) return;
    const request = pendingFileSendRequests.get(requestId);
    if (!request || request.recipientSocketId !== socket.id) return;
    pendingFileSendRequests.delete(requestId);
    io.to(request.senderSocketId).emit(EVENTS.FILE_SEND_APPROVED, {
      requestId,
      recipientId: request.recipientId,
      fileName: request.fileName,
    });
    io.to(request.recipientSocketId).emit(EVENTS.FILE_INCOMING, {
      senderUsername: request.senderUsername,
      fileName: request.fileName,
      fileData: request.fileData,
      fileSize: request.fileSize,
    });
  });

  // FILE_SEND_REJECT
  socket.on(EVENTS.FILE_SEND_REJECT, ({ requestId }) => {
    if (!enforceSocketRateLimit(socket, EVENTS.FILE_SEND_REJECT)) return;
    const check = validateMessage(EVENTS.FILE_SEND_REJECT, { requestId });
    if (!check.valid) return;
    const request = pendingFileSendRequests.get(requestId);
    if (!request || request.recipientSocketId !== socket.id) return;
    pendingFileSendRequests.delete(requestId);
    io.to(request.senderSocketId).emit(EVENTS.FILE_SEND_REJECTED, {
      requestId,
      fileName: request.fileName,
      message: 'Recipient rejected file send',
    });
  });

  // CLIENT_INFO
  socket.on(EVENTS.CLIENT_INFO, async (payload = {}) => {
    if (!enforceSocketRateLimit(socket, EVENTS.CLIENT_INFO)) return;
    const check = validateMessage(EVENTS.CLIENT_INFO, payload);
    if (!check.valid) { console.warn(`[Socket.IO] Invalid message from ${socket.id}: ${check.error}`); return; }
    const session = getSessionBySocketId(socket.id);
    if (!session) return;
    session.endpoints = {
      local: { host: payload.localEndpoint.host, port: payload.localEndpoint.port },
      public: resolvePublicEndpoint(socket, payload),
      relayEligible: payload?.nat?.relayEligible !== false,
      natSupport: { upnp: !!payload?.nat?.upnp, natPmp: !!payload?.nat?.natPmp },
      updatedAt: Date.now(),
    };
    logLifecycleDebug('peer:endpoint:update', 'CONNECTED', session, {
      socketId: socket.id,
      reason: `local=${session.endpoints.local.host}:${session.endpoints.local.port}`,
    });
  });

  // TRANSFER_CONNECTIVITY_REPORT
  socket.on(EVENTS.TRANSFER_CONNECTIVITY_REPORT, (payload = {}) => {
    if (!enforceSocketRateLimit(socket, EVENTS.TRANSFER_CONNECTIVITY_REPORT)) return;
    const check = validateMessage(EVENTS.TRANSFER_CONNECTIVITY_REPORT, payload);
    if (!check.valid) return;
    const session = getSessionBySocketId(socket.id);
    logLifecycleDebug('transfer:connectivity:report', 'CONNECTED', session || {}, {
      socketId: socket.id,
      reason: `${payload.transferId}:${payload.status}`,
    });
  });
}

function payloadSafeFileName(fileRefOrName) {
  if (typeof fileRefOrName !== 'string' || !fileRefOrName.trim()) return 'download.bin';
  const trimmed = fileRefOrName.trim();
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || 'download.bin';
}

module.exports = { attachTransferHandlers };
