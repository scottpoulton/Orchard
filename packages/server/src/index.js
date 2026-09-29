'use strict';

// Load environment variables
require('dotenv').config();

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { PROTOCOL_VERSION, HEARTBEAT, EVENTS, validateMessage } = require('../../shared/protocol');
const { createLifecycleLog } = require('../../shared/lifecycle-log');

const { createState } = require('./state');
const { createAuthRoutes } = require('./auth');
const { createBuddyRoutes } = require('./buddies');
const { attachTransferHandlers } = require('./transfer');
const { attachRelayHandlers } = require('./relay');

// ── Environment ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET environment variable is not set!');
  console.error("Generate a secure secret with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"");
  if (process.env.USE_INSECURE_DEFAULT !== 'true') process.exit(1);
  console.warn('WARNING: Using insecure default JWT secret. This is NOT safe for production!\n');
}
const JWT_SECRET = process.env.JWT_SECRET || 'Orchard-is-awesome-12345!';

let CORS_ORIGIN;
if (process.env.CORS_ORIGIN) {
  CORS_ORIGIN = process.env.CORS_ORIGIN;
} else if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: CORS_ORIGIN must be set in production. Refusing to start with wildcard CORS.');
  process.exit(1);
} else {
  CORS_ORIGIN = '*';
}

const LIFECYCLE_DEBUG = process.env.LIFECYCLE_DEBUG === 'true';
const ENABLE_PUBLIC_USER_SEARCH = process.env.ENABLE_PUBLIC_USER_SEARCH === 'true';
const USER_SEARCH_RATE_WINDOW_MS = Number(process.env.USER_SEARCH_RATE_WINDOW_MS || 60_000);
const USER_SEARCH_RATE_MAX = Number(process.env.USER_SEARCH_RATE_MAX || 30);

// Trust-proxy setting: set TRUST_PROXY=1 (or a specific IP/CIDR) when the broker runs behind
// a reverse proxy (Caddy, Nginx, etc.) so that X-Forwarded-For is used for client IP resolution
// and rate-limiting reflects real client IPs instead of the proxy address.
const TRUST_PROXY = process.env.TRUST_PROXY;

// ── Infrastructure ────────────────────────────────────────────────────────────

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL || 'file:./prisma/dev.db' } },
});

const app = express();
if (TRUST_PROXY) {
  // Accept '1', 'true', a loopback address, a CIDR string, or a comma-separated list.
  const proxyValue = TRUST_PROXY === 'true' ? 1 : (isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));
  app.set('trust proxy', proxyValue);
}
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] } });

// ── Socket rate limiting ───────────────────────────────────────────────────────

const socketRateWindowMs = Number(process.env.SOCKET_RATE_WINDOW_MS || 10_000);
const socketRateMaxEvents = Number(process.env.SOCKET_RATE_MAX_EVENTS || 120);
const socketRateState = new Map();
const operationalMetrics = {
  socketRateLimitedDisconnects: 0,
  userSearchRequests: 0,
  userSearchDeniedDiscoveryDisabled: 0,
  userSearchRateLimited: 0,
};
const SPACE_NAME_MAX_LENGTH = 80;
const MESSAGE_BODY_MAX_LENGTH = 2000;
const ROOM_MESSAGE_BODY_MAX_LENGTH = 2000;
const ROOM_HISTORY_LIMIT = 120;
const UUID_GENERIC_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_CODE_RE = /^[A-Z0-9]{6,32}$/;
const INVITE_CODE_LENGTH = 20;
const INVITE_CODE_COLLISION_MAX_RETRIES = 5;
const PRISMA_UNIQUE_CONSTRAINT_ERROR = 'P2002';

function makeInviteCode() {
  return randomUUID().replace(/-/g, '').slice(0, INVITE_CODE_LENGTH).toUpperCase();
}

function deriveSpaceRole(spaceOwnerId, memberUserId, persistedRole) {
  if (persistedRole === 'owner' || persistedRole === 'member') return persistedRole;
  return spaceOwnerId === memberUserId ? 'owner' : 'member';
}

function getSocketAddress(socket) {
  // When TRUST_PROXY is set the broker is behind a reverse proxy (e.g. Caddy).
  // In that case socket.handshake.address is the proxy's address, not the real
  // client IP. Read the first entry from X-Forwarded-For instead.
  if (TRUST_PROXY && socket && socket.handshake && socket.handshake.headers) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  const raw = socket && socket.handshake && socket.handshake.address || socket && socket.conn && socket.conn.remoteAddress || null;
  if (!raw || typeof raw !== 'string') return null;
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function enforceSocketRateLimit(socket, eventName) {
  const now = Date.now();
  const entry = socketRateState.get(socket.id) || { windowStart: now, count: 0 };
  if (now - entry.windowStart >= socketRateWindowMs) { entry.windowStart = now; entry.count = 0; }
  entry.count += 1;
  socketRateState.set(socket.id, entry);
  if (entry.count > socketRateMaxEvents) {
    operationalMetrics.socketRateLimitedDisconnects += 1;
    logLifecycle('socket:rate_limited', 'ERROR', getSessionBySocketId(socket.id) || {}, {
      socketId: socket.id, errorCode: 'SOCKET_RATE_LIMIT', reason: 'event=' + eventName, level: 'warn',
    });
    socket.emit(EVENTS.ERROR, { code: 'SOCKET_RATE_LIMIT', message: 'Too many socket events' });
    socket.disconnect(true);
    return false;
  }
  return true;
}

function resolvePublicEndpoint(socket, payload) {
  payload = payload || {};
  if (
    payload.publicEndpoint &&
    typeof payload.publicEndpoint.host === 'string' &&
    Number.isInteger(payload.publicEndpoint.port)
  ) {
    return { host: payload.publicEndpoint.host, port: payload.publicEndpoint.port };
  }
  const publicAddress = getSocketAddress(socket);
  if (publicAddress && payload.localEndpoint && payload.localEndpoint.port) {
    return { host: publicAddress, port: payload.localEndpoint.port };
  }
  return null;
}

function resolveOwnerDownloadEndpoint(session, socket) {
  return {
    ownerHost: (session && session.endpoints && session.endpoints.public && session.endpoints.public.host) ||
               (session && session.endpoints && session.endpoints.local && session.endpoints.local.host) ||
               getSocketAddress(socket),
    port: (session && session.endpoints && session.endpoints.public && session.endpoints.public.port) ||
          (session && session.endpoints && session.endpoints.local && session.endpoints.local.port) || null,
    relayEligible: session && session.endpoints && session.endpoints.relayEligible !== false,
  };
}

// ── Logging helpers ────────────────────────────────────────────────────────────

function logLifecycle(event, state, context, opts) {
  context = context || {};
  opts = opts || {};
  const payload = createLifecycleLog({
    clientId: context.clientId,
    sessionId: context.sessionId,
    event,
    state,
    errorCode: opts.errorCode !== undefined ? opts.errorCode : null,
    socketId: opts.socketId !== undefined ? opts.socketId : null,
    reason: opts.reason !== undefined ? opts.reason : null,
  });
  const logMethod = opts.level === 'warn' ? console.warn : opts.level === 'error' ? console.error : console.log;
  logMethod('[Lifecycle]', JSON.stringify(payload));
}

function logLifecycleDebug(event, state, context, opts) {
  if (!LIFECYCLE_DEBUG) return;
  logLifecycle(event, state, context, opts);
}

// ── Audit log helper ──────────────────────────────────────────────────────────

async function logAudit(action, userId, targetUserId, detail) {
  try {
    await prisma.auditLog.create({ data: { action, userId: userId || null, targetUserId: targetUserId || null, detail: detail || null } });
  } catch {
    console.log('[Audit] ' + action + ' userId=' + userId + ' target=' + targetUserId + ' detail=' + detail);
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

async function areBuddiesEitherDirection(userAId, userBId) {
  if (!isPositiveInteger(userAId) || !isPositiveInteger(userBId)) return false;
  if (userAId === userBId) return true;
  const relation = await prisma.buddy.findFirst({
    where: {
      OR: [
        { userId: userAId, buddyId: userBId },
        { userId: userBId, buddyId: userAId },
      ],
    },
    select: { id: true },
  });
  return !!relation;
}

// ── Shared state ───────────────────────────────────────────────────────────────

const stateObj = createState({ prisma, io, logLifecycle, logLifecycleDebug });
const {
  sessions, socketToSession, clientToSession,
  pendingFileSendRequests, relaySessions, brokerEvents,
  setRelaySession, deleteRelaySession, getRelayCountForSocket,
  makeSessionKey, getSessionBySocketId, getOnlineSessions,
  markSessionOffline, clearSweepers,
} = stateObj;

brokerEvents.on('peer:online', function(payload) {
  logLifecycle('peer:online', 'ONLINE', { clientId: payload.clientId, sessionId: payload.sessionId }, {
    reason: payload.reason, socketId: payload.socketId || null,
  });
  io.emit(EVENTS.PEER_ONLINE, payload);
});
brokerEvents.on('peer:offline', function(payload) {
  logLifecycle('peer:offline', 'OFFLINE', { clientId: payload.clientId, sessionId: payload.sessionId }, {
    reason: payload.reason, socketId: payload.socketId || null,
  });
  io.emit(EVENTS.PEER_OFFLINE, payload);
});

// ── Express middleware ─────────────────────────────────────────────────────────

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.get('/', function(_req, res) { res.json({ message: 'Orchard Broker Server is running!' }); });

// ── Public-IP echo ─────────────────────────────────────────────────────────────
// Lightweight endpoint clients can call to confirm their own public IP as seen by
// the broker.  Useful when UPnP is unavailable or untrusted.  No auth required.
app.get('/api/my-ip', function(req, res) {
  const ip = req.ip || req.socket.remoteAddress || null;
  res.json({ ip: ip ? (ip.startsWith('::ffff:') ? ip.slice(7) : ip) : null });
});

const userSearchLimiter = rateLimit({
  windowMs: USER_SEARCH_RATE_WINDOW_MS,
  max: USER_SEARCH_RATE_MAX,
  message: { message: 'Too many user search requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: function(req, res) {
    operationalMetrics.userSearchRateLimited += 1;
    return res.status(429).json({ message: 'Too many user search requests, please try again later' });
  },
});

const spaceRouteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: { message: 'Too many network/space requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminRouteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: { message: 'Too many admin requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const messageReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { message: 'Too many message requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth routes ────────────────────────────────────────────────────────────────

const { verifyToken } = createAuthRoutes(app, { prisma, JWT_SECRET, logAudit });

// ── Buddy routes ───────────────────────────────────────────────────────────────

createBuddyRoutes(app, { prisma, verifyToken, io, getOnlineSessions, logAudit });

// ── User search ────────────────────────────────────────────────────────────────

app.get('/users/search', userSearchLimiter, verifyToken, async function(req, res) {
  try {
    operationalMetrics.userSearchRequests += 1;
    if (!ENABLE_PUBLIC_USER_SEARCH) {
      operationalMetrics.userSearchDeniedDiscoveryDisabled += 1;
      return res.status(403).json({
        message: 'Public user discovery is disabled by this broker. Add buddies by exact username.',
      });
    }
    const q = ((req.query.q || '') + '').toLowerCase().trim();
    if (!q || q.length < 1) return res.status(400).json({ message: 'Query too short' });
    if (q.length > 50) return res.status(400).json({ message: 'Query too long' });
    const users = await prisma.user.findMany({
      where: { username: { contains: q }, NOT: { id: req.userId } },
      select: { id: true, username: true },
      take: 20,
    });
    res.json(users);
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
});

// ── Admin middleware ───────────────────────────────────────────────────────────

const requireAdmin = async function(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } });
    if (!user || user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
    next();
  } catch {
    res.status(500).json({ message: 'Internal server error' });
  }
};

app.get('/admin/users', adminRouteLimiter, verifyToken, requireAdmin, async function(_req, res) {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, role: true, createdAt: true, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ message: 'Failed to list users' });
  }
});

app.patch('/admin/users/:id', adminRouteLimiter, verifyToken, requireAdmin, async function(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isPositiveInteger(id)) return res.status(400).json({ message: 'Invalid user id' });
    if (id === req.userId) return res.status(400).json({ message: 'Cannot modify your own admin account' });
    const data = {};
    if (typeof req.body.enabled === 'boolean') data.enabled = req.body.enabled;
    if (req.body.role === 'admin' || req.body.role === 'user') data.role = req.body.role;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    const updated = await prisma.user.update({
      where: { id }, data,
      select: { id: true, username: true, role: true, enabled: true },
    });
    await logAudit('admin_user_update', req.userId, id, JSON.stringify(data));
    res.json(updated);
  } catch (err) {
    if (err && err.code === 'P2025') return res.status(404).json({ message: 'User not found' });
    console.error('Admin user update error:', err);
    res.status(500).json({ message: 'Failed to update user' });
  }
});

app.get('/admin/audit', adminRouteLimiter, verifyToken, requireAdmin, async function(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage || '50', 10)));
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    });
    res.json(logs);
  } catch (err) {
    console.error('Admin audit error:', err);
    res.status(500).json({ message: 'Failed to fetch audit log' });
  }
});

app.get('/admin/sessions', adminRouteLimiter, verifyToken, requireAdmin, function(_req, res) {
  const active = getOnlineSessions().map(function(s) {
    return { clientId: s.clientId, sessionId: s.sessionId, username: s.user.username, connectedAt: s.connectedAt, lastPingAt: s.lastPingAt };
  });
  res.json(active);
});

app.get('/admin/ops/diagnostics', adminRouteLimiter, verifyToken, requireAdmin, function(_req, res) {
  return res.json({
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    sessions: {
      online: getOnlineSessions().length,
      socketTracked: socketToSession.size,
      clientTracked: clientToSession.size,
    },
    transfers: {
      pendingFileSendRequests: pendingFileSendRequests.size,
      relaySessions: relaySessions.size,
    },
    limits: {
      socketRateWindowMs,
      socketRateMaxEvents,
      userSearchRateWindowMs: USER_SEARCH_RATE_WINDOW_MS,
      userSearchRateMax: USER_SEARCH_RATE_MAX,
    },
    discovery: {
      enablePublicUserSearch: ENABLE_PUBLIC_USER_SEARCH,
    },
    metrics: operationalMetrics,
  });
});

// ── Messaging routes ───────────────────────────────────────────────────────────

app.get('/messages/:userId', messageReadLimiter, verifyToken, async function(req, res) {
  try {
    const otherId = parseInt(req.params.userId, 10);
    if (!isPositiveInteger(otherId)) return res.status(400).json({ message: 'Invalid user id' });
    const canMessage = await areBuddiesEitherDirection(req.userId, otherId);
    if (!canMessage) {
      await logAudit('message_read_denied', req.userId, otherId, 'not-buddies');
      return res.status(403).json({ message: 'Messaging allowed for buddies only' });
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage || '50', 10)));
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: req.userId, recipientId: otherId },
          { senderId: otherId, recipientId: req.userId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
    });
    res.json(messages);
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ message: 'Failed to get messages' });
  }
});

// ── Group spaces routes ────────────────────────────────────────────────────────

app.get('/spaces', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const memberships = await prisma.spaceMember.findMany({
      where: { userId: req.userId },
      include: { space: { include: { owner: { select: { id: true, username: true } } } } },
    });
    res.json(memberships.map(function(m) {
      return {
        ...m.space,
        myRole: deriveSpaceRole(m.space.ownerId, req.userId, m.role),
      };
    }));
  } catch (err) {
    console.error('List spaces error:', err);
    res.status(500).json({ message: 'Failed to list spaces' });
  }
});

app.post('/spaces', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const name = req.body && req.body.name;
    if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > SPACE_NAME_MAX_LENGTH) {
      return res.status(400).json({ message: `Space name is required and must be <= ${SPACE_NAME_MAX_LENGTH} characters` });
    }
    const space = await prisma.space.create({
      data: { name: name.trim(), ownerId: req.userId, members: { create: { userId: req.userId, role: 'owner' } } },
    });
    await logAudit('space_create', req.userId, null, 'space=' + space.id);
    res.status(201).json(space);
  } catch (err) {
    console.error('Create space error:', err);
    res.status(500).json({ message: 'Failed to create space' });
  }
});

app.get('/spaces/:id', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    const membership = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: req.userId } },
      include: {
        space: {
          include: {
            owner: { select: { id: true, username: true } },
            members: {
              include: { user: { select: { id: true, username: true } } },
              orderBy: { joinedAt: 'asc' },
            },
          },
        },
      },
    });
    if (!membership) return res.status(403).json({ message: 'Not a member of this space' });
    const s = membership.space;
    res.json({
      id: s.id,
      name: s.name,
      ownerId: s.ownerId,
      owner: s.owner,
      createdAt: s.createdAt,
      myRole: deriveSpaceRole(s.ownerId, req.userId, membership.role),
      members: s.members.map((m) => ({
        userId: m.userId,
        username: m.user.username,
        role: deriveSpaceRole(s.ownerId, m.userId, m.role),
        joinedAt: m.joinedAt,
      })),
    });
  } catch (err) {
    console.error('Get space detail error:', err);
    res.status(500).json({ message: 'Failed to load space' });
  }
});

app.get('/spaces/:id/invites', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    if (!membership || membership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    const invites = await prisma.spaceInvite.findMany({
      where: { spaceId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invites);
  } catch (err) {
    console.error('List space invites error:', err);
    res.status(500).json({ message: 'Failed to list invites' });
  }
});

app.post('/spaces/:id/invites', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    if (!membership || membership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    const maxUsesRaw = req.body?.maxUses;
    const expiresInHoursRaw = req.body?.expiresInHours;
    const maxUses = Number.isInteger(maxUsesRaw) && maxUsesRaw > 0 ? maxUsesRaw : null;
    const expiresInHours = Number.isInteger(expiresInHoursRaw) && expiresInHoursRaw > 0 ? expiresInHoursRaw : null;
    const expiresAt = expiresInHours ? new Date(Date.now() + (expiresInHours * 60 * 60 * 1000)) : null;

    let invite;
    for (let i = 0; i < INVITE_CODE_COLLISION_MAX_RETRIES; i += 1) {
      const code = makeInviteCode();
      try {
        invite = await prisma.spaceInvite.create({
          data: {
            spaceId,
            code,
            createdById: req.userId,
            maxUses,
            expiresAt,
          },
        });
        break;
      } catch (err) {
        if (!String(err?.code || '').includes(PRISMA_UNIQUE_CONSTRAINT_ERROR)) throw err;
      }
    }
    if (!invite) return res.status(500).json({ message: 'Failed to create invite code' });

    await logAudit('space_invite_create', req.userId, null, `space=${spaceId} invite=${invite.code}`);
    res.status(201).json(invite);
  } catch (err) {
    console.error('Create space invite error:', err);
    res.status(500).json({ message: 'Failed to create invite' });
  }
});

app.delete('/spaces/:id/invites/:inviteId', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    const inviteId = (req.params.inviteId || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    if (!inviteId || !UUID_GENERIC_RE.test(inviteId)) return res.status(400).json({ message: 'Invalid invite id' });
    const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    if (!membership || membership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    await prisma.spaceInvite.update({ where: { id: inviteId }, data: { revoked: true } });
    await logAudit('space_invite_revoke', req.userId, null, `space=${spaceId} inviteId=${inviteId}`);
    res.json({ message: 'Invite revoked' });
  } catch (err) {
    if (err && err.code === 'P2025') return res.status(404).json({ message: 'Invite not found' });
    console.error('Revoke space invite error:', err);
    res.status(500).json({ message: 'Failed to revoke invite' });
  }
});

app.post('/spaces/join-by-code', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const inviteCode = ((req.body?.inviteCode || '') + '').trim().toUpperCase();
    if (!inviteCode || !INVITE_CODE_RE.test(inviteCode)) {
      return res.status(400).json({ message: 'Invalid invite code' });
    }
    const invite = await prisma.spaceInvite.findUnique({
      where: { code: inviteCode },
      include: { space: { select: { id: true, ownerId: true, name: true } } },
    });
    if (!invite || invite.revoked) return res.status(404).json({ message: 'Invite not found' });
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ message: 'Invite expired' });
    }
    if (invite.maxUses && invite.uses >= invite.maxUses) {
      return res.status(410).json({ message: 'Invite exhausted' });
    }
    if (invite.space.ownerId === req.userId) {
      return res.status(400).json({ message: 'You already own this space' });
    }
    const existing = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: invite.space.id, userId: req.userId } },
    });
    if (existing) {
      return res.status(200).json({ message: 'Already a member', status: 'already-member', spaceId: invite.space.id });
    }

    // Use a transaction so the use-count increment and join-request creation are
    // atomic, preventing two concurrent requests from both slipping past the
    // maxUses guard above.
    const { joinRequest } = await prisma.$transaction(async (tx) => {
      const freshInvite = await tx.spaceInvite.findUnique({ where: { id: invite.id }, select: { uses: true, maxUses: true, revoked: true } });
      if (!freshInvite || freshInvite.revoked) throw Object.assign(new Error('Invite not found'), { status: 404 });
      if (freshInvite.maxUses && freshInvite.uses >= freshInvite.maxUses) throw Object.assign(new Error('Invite exhausted'), { status: 410 });

      await tx.spaceInvite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } });
      const req2 = await tx.spaceJoinRequest.upsert({
        where: { spaceId_requesterId: { spaceId: invite.space.id, requesterId: req.userId } },
        update: { status: 'pending', reviewedById: null, reviewedAt: null },
        create: { spaceId: invite.space.id, requesterId: req.userId, status: 'pending' },
        include: { requester: { select: { id: true, username: true } }, space: { select: { id: true, name: true, ownerId: true } } },
      });
      return { joinRequest: req2 };
    });
    await logAudit('space_join_requested', req.userId, invite.space.ownerId, `space=${invite.space.id}`);
    res.status(202).json({
      message: 'Join request submitted',
      status: 'pending',
      request: {
        id: joinRequest.id,
        spaceId: joinRequest.space.id,
        spaceName: joinRequest.space.name,
      },
    });
  } catch (err) {
    if (err && err.status === 404) return res.status(404).json({ message: 'Invite not found' });
    if (err && err.status === 410) return res.status(410).json({ message: 'Invite exhausted' });
    console.error('Join by invite code error:', err);
    res.status(500).json({ message: 'Failed to submit join request' });
  }
});

app.get('/spaces/:id/requests', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    if (!membership || membership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    const requests = await prisma.spaceJoinRequest.findMany({
      where: { spaceId, status: 'pending' },
      include: { requester: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(requests.map((r) => ({
      id: r.id,
      requesterId: r.requesterId,
      requesterUsername: r.requester.username,
      createdAt: r.createdAt,
      status: r.status,
    })));
  } catch (err) {
    console.error('List space requests error:', err);
    res.status(500).json({ message: 'Failed to list join requests' });
  }
});

app.post('/spaces/:id/requests/:requestId/approve', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    const requestId = (req.params.requestId || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    if (!requestId || !UUID_GENERIC_RE.test(requestId)) return res.status(400).json({ message: 'Invalid request id' });
    const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    if (!membership || membership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    const joinRequest = await prisma.spaceJoinRequest.findUnique({ where: { id: requestId } });
    if (!joinRequest || joinRequest.spaceId !== spaceId) return res.status(404).json({ message: 'Join request not found' });
    if (joinRequest.status !== 'pending') return res.status(400).json({ message: 'Join request already reviewed' });
    await prisma.$transaction([
      prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId: joinRequest.requesterId } },
        update: { role: 'member' },
        create: { spaceId, userId: joinRequest.requesterId, role: 'member' },
      }),
      prisma.spaceJoinRequest.update({
        where: { id: requestId },
        data: { status: 'approved', reviewedById: req.userId, reviewedAt: new Date() },
      }),
    ]);
    await logAudit('space_join_approved', req.userId, joinRequest.requesterId, `space=${spaceId}`);
    res.json({ message: 'Join request approved' });
  } catch (err) {
    console.error('Approve space request error:', err);
    res.status(500).json({ message: 'Failed to approve join request' });
  }
});

app.post('/spaces/:id/requests/:requestId/reject', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    const requestId = (req.params.requestId || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    if (!requestId || !UUID_GENERIC_RE.test(requestId)) return res.status(400).json({ message: 'Invalid request id' });
    const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    if (!membership || membership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    const joinRequest = await prisma.spaceJoinRequest.findUnique({ where: { id: requestId } });
    if (!joinRequest || joinRequest.spaceId !== spaceId) return res.status(404).json({ message: 'Join request not found' });
    if (joinRequest.status !== 'pending') return res.status(400).json({ message: 'Join request already reviewed' });
    await prisma.spaceJoinRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', reviewedById: req.userId, reviewedAt: new Date() },
    });
    await logAudit('space_join_rejected', req.userId, joinRequest.requesterId, `space=${spaceId}`);
    res.json({ message: 'Join request rejected' });
  } catch (err) {
    console.error('Reject space request error:', err);
    res.status(500).json({ message: 'Failed to reject join request' });
  }
});

app.post('/spaces/:id/join', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    const space = await prisma.space.findUnique({
      where: { id: spaceId },
      select: { id: true, ownerId: true },
    });
    if (!space) return res.status(404).json({ message: 'Space not found' });
    const allowed = await areBuddiesEitherDirection(req.userId, space.ownerId) || req.userId === space.ownerId;
    if (!allowed) {
      await logAudit('space_join_denied', req.userId, space.ownerId, 'not-authorized');
      return res.status(403).json({ message: 'Only the owner or owner buddies can join this space' });
    }
    await prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId: req.userId } },
      update: {},
      create: { spaceId, userId: req.userId },
    });
    await logAudit('space_join', req.userId, space.ownerId, 'space=' + spaceId);
    res.json({ message: 'Joined space' });
  } catch (err) {
    console.error('Join space error:', err);
    res.status(500).json({ message: 'Failed to join space' });
  }
});

app.post('/spaces/:id/leave', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    const membership = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: req.userId } },
      include: { space: { select: { ownerId: true } } },
    });
    if (!membership) return res.status(404).json({ message: 'Membership not found' });
    if (membership.space.ownerId === req.userId) return res.status(400).json({ message: 'Owner cannot leave; transfer or delete space first' });
    await prisma.spaceMember.delete({ where: { spaceId_userId: { spaceId, userId: req.userId } } });
    await logAudit('space_leave', req.userId, null, `space=${spaceId}`);
    res.json({ message: 'Left space' });
  } catch (err) {
    console.error('Leave space error:', err);
    res.status(500).json({ message: 'Failed to leave space' });
  }
});

app.delete('/spaces/:id/members/:memberId', spaceRouteLimiter, verifyToken, async function(req, res) {
  try {
    const spaceId = (req.params.id || '').trim();
    const memberId = parseInt(req.params.memberId, 10);
    if (!spaceId || !UUID_GENERIC_RE.test(spaceId)) return res.status(400).json({ message: 'Invalid space id' });
    if (!isPositiveInteger(memberId)) return res.status(400).json({ message: 'Invalid member id' });
    const ownerMembership = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: req.userId } },
      include: { space: { select: { ownerId: true } } },
    });
    if (!ownerMembership || ownerMembership.role !== 'owner') return res.status(403).json({ message: 'Owner access required' });
    if (memberId === ownerMembership.space.ownerId) return res.status(400).json({ message: 'Cannot remove owner from space' });
    await prisma.spaceMember.delete({ where: { spaceId_userId: { spaceId, userId: memberId } } });
    await logAudit('space_member_kick', req.userId, memberId, `space=${spaceId}`);
    res.json({ message: 'Member removed' });
  } catch (err) {
    if (err && err.code === 'P2025') return res.status(404).json({ message: 'Member not found' });
    console.error('Kick space member error:', err);
    res.status(500).json({ message: 'Failed to remove member' });
  }
});

// ── Socket.IO lobby ────────────────────────────────────────────────────────────

io.on('connection', function(socket) {
  logLifecycle('socket:connect', 'CONNECTING', {}, { socketId: socket.id });
  var hasHello = false;

  socket.on(EVENTS.HELLO, async function(helloPayload) {
    helloPayload = helloPayload || {};
    const check = validateMessage(EVENTS.HELLO, helloPayload);
    if (!check.valid) {
      const invalidClientId = typeof helloPayload.clientId === 'string' ? helloPayload.clientId.trim() : null;
      logLifecycle('hello:invalid', 'ERROR', { clientId: invalidClientId, sessionId: null }, {
        socketId: socket.id, errorCode: 'INVALID_HELLO', reason: check.error, level: 'warn',
      });
      socket.emit(EVENTS.ERROR, { code: 'INVALID_HELLO', message: check.error });
      socket.disconnect();
      return;
    }

    const clientId = helloPayload.clientId.trim();
    const existingKey = clientToSession.get(clientId);
    var sessionKey, session;

    if (existingKey && sessions.has(existingKey)) {
      sessionKey = existingKey;
      session = sessions.get(existingKey);
      if (session.socketId && session.socketId !== socket.id) socketToSession.delete(session.socketId);
      session.socketId = socket.id;
      session.disconnectedAt = null;
      session.lastPingAt = Date.now();
      logLifecycle('session:resume', 'CONNECTED', session, { socketId: socket.id, reason: 'reconnect' });
      brokerEvents.emit('peer:online', { clientId: session.clientId, sessionId: session.sessionId, socketId: socket.id, reason: 'reconnect' });
    } else {
      const sessionId = randomUUID();
      sessionKey = makeSessionKey(clientId, sessionId);
      session = {
        clientId, sessionId, socketId: socket.id,
        user: null, files: [],
        endpoints: { local: null, public: null, relayEligible: true, natSupport: { upnp: false, natPmp: false }, updatedAt: null },
        connectedAt: Date.now(), disconnectedAt: null, lastPingAt: Date.now(),
      };
      sessions.set(sessionKey, session);
      clientToSession.set(clientId, sessionKey);
      logLifecycle('session:create', 'CONNECTED', session, { socketId: socket.id, reason: 'new-session' });
      brokerEvents.emit('peer:online', { clientId, sessionId, socketId: socket.id, reason: 'new-session' });
    }

    socketToSession.set(socket.id, sessionKey);
    hasHello = true;
    socket.emit(EVENTS.HELLO_ACK, { sessionId: session.sessionId, serverTime: Date.now() });
  });

  socket.on(EVENTS.PING, function(payload) {
    payload = payload || {};
    if (!enforceSocketRateLimit(socket, EVENTS.PING)) return;
    const check = validateMessage(EVENTS.PING, payload);
    if (!check.valid) { console.warn('[Socket.IO] Invalid PING from ' + socket.id + ': ' + check.error); return; }
    const session = getSessionBySocketId(socket.id);
    if (!session) return;
    session.lastPingAt = Date.now();
    logLifecycleDebug('heartbeat:ping', 'CONNECTED', session, { socketId: socket.id });
    socket.emit(EVENTS.PONG, { sessionId: session.sessionId, serverTime: Date.now(), clientTime: payload.clientTime });
  });

  socket.on(EVENTS.AUTHENTICATE, async function(token) {
    if (!enforceSocketRateLimit(socket, EVENTS.AUTHENTICATE)) return;
    if (!hasHello) {
      logLifecycle('auth:rejected', 'ERROR', getSessionBySocketId(socket.id) || {}, {
        socketId: socket.id, errorCode: 'HANDSHAKE_REQUIRED', reason: 'Handshake required', level: 'warn',
      });
      socket.emit(EVENTS.AUTH_ERROR, 'Handshake required');
      socket.disconnect();
      return;
    }
    const check = validateMessage(EVENTS.AUTHENTICATE, token);
    if (!check.valid) {
      logLifecycle('auth:rejected', 'ERROR', getSessionBySocketId(socket.id) || {}, {
        socketId: socket.id, errorCode: 'INVALID_AUTH_PAYLOAD', reason: check.error, level: 'warn',
      });
      socket.emit(EVENTS.AUTH_ERROR, 'Authentication failed');
      socket.disconnect();
      return;
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, role: true, enabled: true },
      });
      if (!user) throw new Error('User not found');
      if (user.enabled === false) throw new Error('Account disabled');

      const session = getSessionBySocketId(socket.id);
      if (!session) {
        logLifecycle('auth:rejected', 'ERROR', {}, { socketId: socket.id, errorCode: 'SESSION_NOT_FOUND', level: 'warn' });
        socket.emit(EVENTS.AUTH_ERROR, 'Session not found');
        socket.disconnect();
        return;
      }
      session.user = user;
      logLifecycle('auth:success', 'AUTHENTICATED', session, { socketId: socket.id });
      socket.emit(EVENTS.AUTH_SUCCESS, user);

      const buddies = await prisma.buddy.findMany({ where: { userId: decoded.userId }, select: { buddyId: true } });
      const buddyIds = new Set(buddies.map(function(b) { return b.buddyId; }));
      const otherClients = getOnlineSessions()
        .filter(function(c) { return c.user.id !== user.id && buddyIds.has(c.user.id); })
        .map(function(c) {
          return {
            user: c.user,
            files: c.files,
            endpoints: c.endpoints,
            clientId: c.clientId,
          };
        });
      socket.emit(EVENTS.USERS_LIST, otherClients);

      const online = getOnlineSessions();
      const onlineUserIds = online.map(function(clientData) { return clientData.user.id; });
      const reverseBuddyRows = await prisma.buddy.findMany({
        where: { buddyId: user.id, userId: { in: onlineUserIds } },
        select: { userId: true },
      });
      const reverseBuddyIds = new Set(reverseBuddyRows.map(function(row) { return row.userId; }));
      for (const clientData of online) {
        if (clientData.user.id === user.id) continue;
        if (reverseBuddyIds.has(clientData.user.id)) {
          io.to(clientData.socketId).emit(EVENTS.USER_ONLINE, {
            user: session.user,
            files: session.files,
            endpoints: session.endpoints,
            clientId: session.clientId,
          });
        }
      }
    } catch (err) {
      logLifecycle('auth:rejected', 'ERROR', getSessionBySocketId(socket.id) || {}, {
        socketId: socket.id, errorCode: 'AUTH_FAILED', reason: err.message, level: 'warn',
      });
      socket.emit(EVENTS.AUTH_ERROR, 'Authentication failed');
      socket.disconnect();
    }
  });

  attachTransferHandlers(socket, {
    prisma, io,
    getSessionBySocketId, getOnlineSessions,
    pendingFileSendRequests,
    enforceSocketRateLimit,
    resolvePublicEndpoint,
    resolveOwnerDownloadEndpoint,
    logLifecycle, logLifecycleDebug, logAudit,
    randomUUID,
  });

  attachRelayHandlers(socket, {
    io, getSessionBySocketId, getOnlineSessions,
    relaySessions, setRelaySession, deleteRelaySession, getRelayCountForSocket,
    enforceSocketRateLimit, logLifecycleDebug,
  });

  socket.on(EVENTS.MESSAGE_SEND, async function(payload) {
    payload = payload || {};
    if (!enforceSocketRateLimit(socket, EVENTS.MESSAGE_SEND)) return;
    const messageBody = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (!isPositiveInteger(payload.recipientId) || !messageBody) {
      socket.emit(EVENTS.ERROR, { code: 'INVALID_MESSAGE_PAYLOAD', message: 'Invalid message payload' });
      return;
    }
    if (messageBody.length > MESSAGE_BODY_MAX_LENGTH) {
      socket.emit(EVENTS.ERROR, {
        code: 'MESSAGE_TOO_LONG',
        message: `Message must be ${MESSAGE_BODY_MAX_LENGTH} characters or fewer`,
      });
      return;
    }
    const sender = getSessionBySocketId(socket.id);
    if (!sender || !sender.user) return;
    try {
      const canMessage = await areBuddiesEitherDirection(sender.user.id, payload.recipientId);
      if (!canMessage) {
        await logAudit('message_send_denied', sender.user.id, payload.recipientId, 'not-buddies');
        socket.emit(EVENTS.ERROR, { code: 'MESSAGE_FORBIDDEN', message: 'Messaging allowed for buddies only' });
        return;
      }
      const msg = await prisma.message.create({
        data: { senderId: sender.user.id, recipientId: payload.recipientId, body: messageBody },
      });
      const outbound = { id: msg.id, senderId: msg.senderId, recipientId: msg.recipientId, body: msg.body, createdAt: msg.createdAt };
      socket.emit(EVENTS.MESSAGE_RECEIVE, outbound);
      const recipientSession = getOnlineSessions().find(function(s) { return s.user.id === payload.recipientId; });
      if (recipientSession) io.to(recipientSession.socketId).emit(EVENTS.MESSAGE_RECEIVE, outbound);
    } catch (err) {
      console.error('Message send error:', err);
    }
  });

  socket.on(EVENTS.ROOM_JOIN, async function(payload = {}) {
    if (!enforceSocketRateLimit(socket, EVENTS.ROOM_JOIN)) return;
    const check = validateMessage(EVENTS.ROOM_JOIN, payload);
    if (!check.valid) {
      socket.emit(EVENTS.ERROR, { code: 'INVALID_ROOM_JOIN', message: 'Invalid room join payload' });
      return;
    }
    const session = getSessionBySocketId(socket.id);
    if (!session || !session.user) return;
    try {
      const membership = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: payload.spaceId, userId: session.user.id } },
        select: { spaceId: true },
      });
      if (!membership) {
        socket.emit(EVENTS.ERROR, { code: 'ROOM_FORBIDDEN', message: 'Not a member of this room' });
        return;
      }
      socket.join(`space:${payload.spaceId}`);
      const history = await prisma.spaceRoomMessage.findMany({
        where: { spaceId: payload.spaceId },
        orderBy: { createdAt: 'asc' },
        take: ROOM_HISTORY_LIMIT,
        include: { sender: { select: { id: true, username: true } } },
      });
      socket.emit(EVENTS.ROOM_HISTORY, {
        spaceId: payload.spaceId,
        messages: history.map((m) => ({
          id: m.id,
          spaceId: m.spaceId,
          senderId: m.senderId,
          senderUsername: m.sender.username,
          body: m.body,
          createdAt: m.createdAt,
        })),
      });
    } catch (err) {
      console.error('Room join error:', err);
    }
  });

  socket.on(EVENTS.ROOM_LEAVE, async function(payload = {}) {
    if (!enforceSocketRateLimit(socket, EVENTS.ROOM_LEAVE)) return;
    const check = validateMessage(EVENTS.ROOM_LEAVE, payload);
    if (!check.valid) return;
    socket.leave(`space:${payload.spaceId}`);
  });

  socket.on(EVENTS.ROOM_MESSAGE_SEND, async function(payload = {}) {
    if (!enforceSocketRateLimit(socket, EVENTS.ROOM_MESSAGE_SEND)) return;
    const check = validateMessage(EVENTS.ROOM_MESSAGE_SEND, payload);
    if (!check.valid) {
      socket.emit(EVENTS.ERROR, { code: 'INVALID_ROOM_MESSAGE', message: 'Invalid room message payload' });
      return;
    }
    const session = getSessionBySocketId(socket.id);
    if (!session || !session.user) return;
    const body = payload.body.trim();
    if (!body || body.length > ROOM_MESSAGE_BODY_MAX_LENGTH) {
      socket.emit(EVENTS.ERROR, {
        code: 'ROOM_MESSAGE_TOO_LONG',
        message: `Room message must be ${ROOM_MESSAGE_BODY_MAX_LENGTH} characters or fewer`,
      });
      return;
    }
    try {
      const membership = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: payload.spaceId, userId: session.user.id } },
        select: { spaceId: true },
      });
      if (!membership) {
        socket.emit(EVENTS.ERROR, { code: 'ROOM_FORBIDDEN', message: 'Not a member of this room' });
        return;
      }
      const msg = await prisma.spaceRoomMessage.create({
        data: { spaceId: payload.spaceId, senderId: session.user.id, body },
      });
      io.to(`space:${payload.spaceId}`).emit(EVENTS.ROOM_MESSAGE, {
        spaceId: payload.spaceId,
        message: {
          id: msg.id,
          spaceId: msg.spaceId,
          senderId: session.user.id,
          senderUsername: session.user.username,
          body: msg.body,
          createdAt: msg.createdAt,
        },
      });
    } catch (err) {
      console.error('Room message send error:', err);
    }
  });

  socket.on('disconnect', async function() {
    socketRateState.delete(socket.id);
    for (const [id, req] of pendingFileSendRequests.entries()) {
      if (req.senderSocketId === socket.id || req.recipientSocketId === socket.id) pendingFileSendRequests.delete(id);
    }
    for (const [relayId, relaySession] of relaySessions.entries()) {
      if (relaySession.ownerSocketId === socket.id) {
        io.to(relaySession.requesterSocketId).emit(EVENTS.RELAY_DONE, { relayId, error: 'Owner disconnected during relay' });
        deleteRelaySession(relayId);
      } else if (relaySession.requesterSocketId === socket.id) {
        deleteRelaySession(relayId);
      }
    }
    logLifecycle('socket:disconnect', 'DISCONNECTED', getSessionBySocketId(socket.id) || {}, { socketId: socket.id });
    const clientData = getSessionBySocketId(socket.id);
    if (clientData && clientData.socketId === socket.id) {
      await markSessionOffline(clientData, 'socket-disconnect', { socketId: socket.id });
    }
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

['SIGINT', 'SIGTERM'].forEach(function(sig) {
  process.once(sig, function() {
    console.log(`[${sig}] Shutting down...`);
    clearSweepers();
    server.close(function() {
      prisma.$disconnect().catch(() => {}).finally(() => process.exit(0));
    });
    // Force-exit after 10 s if graceful shutdown stalls
    setTimeout(() => process.exit(1), 10_000).unref();
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, function() {
  console.log('Orchard Broker Server listening on http://localhost:' + PORT + ' (protocol v' + PROTOCOL_VERSION + ')');
});
