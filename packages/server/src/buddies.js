'use strict';

/**
 * REST buddy-list routes: GET /buddies, POST /buddies, DELETE /buddies/:buddyId.
 * Also handles bidirectional buddy requests:
 *   POST   /buddies/request        – send a buddy request
 *   POST   /buddies/request/accept  – accept a request
 *   POST   /buddies/request/decline – decline a request
 *   GET    /buddies/requests        – list incoming pending requests
 */

const { EVENTS } = require('../../shared/protocol');

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * @param {import('express').Application} app
 * @param {{ prisma, verifyToken, io, getOnlineSessions, logAudit, authLimiterLight }} services
 */
function createBuddyRoutes(app, { prisma, verifyToken, io, getOnlineSessions, logAudit }) {
  // GET /buddies
  app.get('/buddies', verifyToken, async (req, res) => {
    try {
      const buddies = await prisma.buddy.findMany({
        where: { userId: req.userId },
        include: { buddy: { select: { id: true, username: true, createdAt: true } } },
      });
      res.json(buddies.map((b) => b.buddy));
    } catch (err) {
      console.error('Get buddies error:', err);
      res.status(500).json({ message: 'Failed to get buddy list' });
    }
  });

  // POST /buddies (legacy direct-add – still works for backward compatibility)
  app.post('/buddies', verifyToken, async (req, res) => {
    try {
      const { username } = req.body;
      if (!username) return res.status(400).json({ message: 'Username is required' });
      const usernameLower = username.toLowerCase();
      const buddyUser = await prisma.user.findUnique({ where: { username: usernameLower } });
      if (!buddyUser) return res.status(404).json({ message: 'User not found' });
      if (buddyUser.id === req.userId) return res.status(400).json({ message: 'Cannot add yourself as buddy' });
      const existing = await prisma.buddy.findUnique({
        where: { userId_buddyId: { userId: req.userId, buddyId: buddyUser.id } },
      });
      if (existing) return res.status(400).json({ message: 'Already in buddy list' });
      await prisma.buddy.create({ data: { userId: req.userId, buddyId: buddyUser.id } });
      logAudit?.('buddy_add', req.userId, buddyUser.id, `added buddy ${buddyUser.username}`);
      res.status(201).json({ message: 'Buddy added successfully', buddy: { id: buddyUser.id, username: buddyUser.username } });
    } catch (err) {
      console.error('Add buddy error:', err);
      res.status(500).json({ message: 'Failed to add buddy' });
    }
  });

  // DELETE /buddies/:buddyId
  app.delete('/buddies/:buddyId', verifyToken, async (req, res) => {
    try {
      const buddyId = parseInt(req.params.buddyId, 10);
      if (!isPositiveInteger(buddyId)) return res.status(400).json({ message: 'Invalid buddy id' });
      await prisma.buddy.deleteMany({ where: { userId: req.userId, buddyId } });
      logAudit?.('buddy_remove', req.userId, buddyId, `removed buddy id=${buddyId}`);
      res.json({ message: 'Buddy removed successfully' });
    } catch (err) {
      console.error('Remove buddy error:', err);
      res.status(500).json({ message: 'Failed to remove buddy' });
    }
  });

  // ── Bidirectional buddy requests ──────────────────────────────────────────

  // POST /buddies/request – send a buddy request to another user
  app.post('/buddies/request', verifyToken, async (req, res) => {
    try {
      const { username } = req.body;
      if (!username) return res.status(400).json({ message: 'Username is required' });
      const targetUser = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
      if (!targetUser) return res.status(404).json({ message: 'User not found' });
      if (targetUser.id === req.userId) return res.status(400).json({ message: 'Cannot send buddy request to yourself' });

      // Already buddies?
      const alreadyBuddy = await prisma.buddy.findUnique({
        where: { userId_buddyId: { userId: req.userId, buddyId: targetUser.id } },
      });
      if (alreadyBuddy) return res.status(400).json({ message: 'Already in buddy list' });

      // Already a pending request?
      const existingReq = await prisma.buddyRequest.findUnique({
        where: { fromId_toId: { fromId: req.userId, toId: targetUser.id } },
      });
      if (existingReq) return res.status(400).json({ message: 'Buddy request already sent' });

      const fromUser = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, username: true } });

      const request = await prisma.buddyRequest.create({ data: { fromId: req.userId, toId: targetUser.id } });

      // Notify the target if they are online
      const targetSession = getOnlineSessions().find((s) => s.user.id === targetUser.id);
      if (targetSession) {
        io.to(targetSession.socketId).emit(EVENTS.BUDDY_REQUESTED, {
          requestId: request.id,
          from: fromUser,
        });
      }

      logAudit?.('buddy_request', req.userId, targetUser.id, `sent buddy request`);
      res.status(201).json({ message: 'Buddy request sent', requestId: request.id });
    } catch (err) {
      console.error('Buddy request error:', err);
      res.status(500).json({ message: 'Failed to send buddy request' });
    }
  });

  // GET /buddies/requests – list incoming pending requests
  app.get('/buddies/requests', verifyToken, async (req, res) => {
    try {
      const requests = await prisma.buddyRequest.findMany({
        where: { toId: req.userId },
        include: { from: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json(requests.map((r) => ({ requestId: r.id, from: r.from, createdAt: r.createdAt })));
    } catch (err) {
      console.error('Get buddy requests error:', err);
      res.status(500).json({ message: 'Failed to get buddy requests' });
    }
  });

  // POST /buddies/request/accept
  app.post('/buddies/request/accept', verifyToken, async (req, res) => {
    try {
      const { requestId } = req.body;
      if (!requestId) return res.status(400).json({ message: 'requestId is required' });
      const request = await prisma.buddyRequest.findUnique({ where: { id: requestId } });
      if (!request || request.toId !== req.userId) return res.status(404).json({ message: 'Request not found' });

      const [, , acceptorUser] = await Promise.all([
        prisma.buddy.upsert({
          where: { userId_buddyId: { userId: request.fromId, buddyId: request.toId } },
          update: {},
          create: { userId: request.fromId, buddyId: request.toId },
        }),
        prisma.buddy.upsert({
          where: { userId_buddyId: { userId: request.toId, buddyId: request.fromId } },
          update: {},
          create: { userId: request.toId, buddyId: request.fromId },
        }),
        prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, username: true } }),
      ]);
      await prisma.buddyRequest.delete({ where: { id: requestId } });

      // Notify requester if online
      const requesterSession = getOnlineSessions().find((s) => s.user.id === request.fromId);
      if (requesterSession) {
        io.to(requesterSession.socketId).emit(EVENTS.BUDDY_ACCEPTED, { friend: acceptorUser });
      }

      logAudit?.('buddy_accept', req.userId, request.fromId, `accepted buddy request`);
      res.json({ message: 'Buddy request accepted' });
    } catch (err) {
      console.error('Accept buddy request error:', err);
      res.status(500).json({ message: 'Failed to accept buddy request' });
    }
  });

  // POST /buddies/request/decline
  app.post('/buddies/request/decline', verifyToken, async (req, res) => {
    try {
      const { requestId } = req.body;
      if (!requestId) return res.status(400).json({ message: 'requestId is required' });
      const request = await prisma.buddyRequest.findUnique({ where: { id: requestId } });
      if (!request || request.toId !== req.userId) return res.status(404).json({ message: 'Request not found' });
      await prisma.buddyRequest.delete({ where: { id: requestId } });

      // Notify requester if online
      const requesterSession = getOnlineSessions().find((s) => s.user.id === request.fromId);
      if (requesterSession) {
        io.to(requesterSession.socketId).emit(EVENTS.BUDDY_DECLINED, { toId: request.toId });
      }

      logAudit?.('buddy_decline', req.userId, request.fromId, `declined buddy request`);
      res.json({ message: 'Buddy request declined' });
    } catch (err) {
      console.error('Decline buddy request error:', err);
      res.status(500).json({ message: 'Failed to decline buddy request' });
    }
  });
}

module.exports = { createBuddyRoutes };
