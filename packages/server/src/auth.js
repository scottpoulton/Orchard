'use strict';

/**
 * REST authentication routes: POST /register, POST /login.
 * Also exports the `verifyToken` Express middleware.
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { randomBytes } = require('crypto');

const USERNAME_RE = /^[a-z0-9_]{1,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

function normalizeRecoveryCode(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function formatRecoveryCode(normalizedCode) {
  if (!normalizedCode) return '';
  const chunks = normalizedCode.match(/[A-Z0-9]{1,4}/g);
  if (!chunks) return normalizedCode;
  return chunks.join('-');
}

function generateRecoveryCode() {
  const normalizedCode = randomBytes(8).toString('hex').toUpperCase();
  return {
    normalizedCode,
    displayCode: formatRecoveryCode(normalizedCode),
  };
}

function validateUsername(username) {
  if (typeof username !== 'string') return false;
  return USERNAME_RE.test(username.toLowerCase());
}

function createAuthLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { message: 'Too many authentication attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

function createLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { message: 'Too many login attempts, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });
}

function createRecoveryLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { message: 'Too many recovery attempts, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });
}

/**
 * Register auth routes on `app` and return { verifyToken }.
 *
 * @param {import('express').Application} app
 * @param {{ prisma: import('@prisma/client').PrismaClient, JWT_SECRET: string, logAudit?: Function }} services
 */
function createAuthRoutes(app, { prisma, JWT_SECRET, logAudit }) {
  const authLimiter = createAuthLimiter();
  const loginLimiter = createLoginLimiter();
  const recoveryLimiter = createRecoveryLimiter();

  /** Express middleware: requires a valid Bearer JWT, sets req.userId. Also enforces account enabled status. */
  const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, enabled: true },
      });
      if (!user) return res.status(401).json({ message: 'User not found' });
      if (user.enabled === false) return res.status(403).json({ message: 'Account disabled' });
      req.userId = decoded.userId;
      next();
    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Invalid token' });
      }
      console.error('Token verification error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  };

  // POST /register
  app.post('/register', authLimiter, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
      }
      if (!validateUsername(username)) {
        return res.status(400).json({
          message: 'Username must be 1–32 characters and contain only letters, numbers, or underscores',
        });
      }
      if (
        typeof password !== 'string' ||
        password.length < PASSWORD_MIN_LENGTH ||
        password.length > PASSWORD_MAX_LENGTH
      ) {
        return res.status(400).json({
          message: `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
        });
      }
      const usernameLower = username.toLowerCase();
      const existing = await prisma.user.findUnique({ where: { username: usernameLower } });
      if (existing) return res.status(409).json({ message: 'Username already taken' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const recoveryCode = generateRecoveryCode();
      const recoveryCodeHash = await bcrypt.hash(recoveryCode.normalizedCode, 10);

      // First registered user becomes admin – use a transaction to prevent a race
      // condition where two simultaneous registrations both become admins.
      const newUser = await prisma.$transaction(async (tx) => {
        const userCount = await tx.user.count();
        const role = userCount === 0 ? 'admin' : 'user';
        return tx.user.create({
          data: {
            username: usernameLower,
            password: hashedPassword,
            role,
            recoveryCodeHash,
            recoveryCodeUpdatedAt: new Date(),
          },
        });
      });

      logAudit?.('register', newUser.id, null, `registered role=${newUser.role}`);
      res.status(201).json({
        message: 'User created successfully',
        userId: newUser.id,
        recoveryCode: recoveryCode.displayCode,
      });
    } catch (err) {
      console.error('Registration error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // POST /login
  app.post('/login', loginLimiter, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
      }
      const usernameLower = username.toLowerCase();
      const user = await prisma.user.findUnique({ where: { username: usernameLower } });
      if (!user) {
        logAudit?.('login_failed', null, null, `unknown username=${usernameLower}`);
        return res.status(401).json({ message: 'Invalid username or password' });
      }
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        logAudit?.('login_failed', user.id, null, `bad password`);
        return res.status(401).json({ message: 'Invalid username or password' });
      }
      if (user.enabled === false) {
        logAudit?.('login_failed', user.id, null, 'account disabled');
        return res.status(403).json({ message: 'Account disabled' });
      }
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1d' });
      logAudit?.('login', user.id, null, `login successful`);
      res.status(200).json({ message: 'Login successful', token });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // POST /recovery/reset-password
  app.post('/recovery/reset-password', recoveryLimiter, async (req, res) => {
    try {
      const { username, recoveryCode, newPassword } = req.body || {};
      if (!username || !recoveryCode || !newPassword) {
        return res.status(400).json({ message: 'Username, recovery code, and new password are required' });
      }
      if (
        typeof newPassword !== 'string' ||
        newPassword.length < PASSWORD_MIN_LENGTH ||
        newPassword.length > PASSWORD_MAX_LENGTH
      ) {
        return res.status(400).json({
          message: `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
        });
      }

      const usernameLower = username.toLowerCase().trim();
      const user = await prisma.user.findUnique({
        where: { username: usernameLower },
        select: { id: true, username: true, enabled: true, recoveryCodeHash: true },
      });
      if (!user || user.enabled === false || !user.recoveryCodeHash) {
        logAudit?.('recovery_reset_failed', null, null, `invalid recovery user=${usernameLower}`);
        return res.status(401).json({ message: 'Invalid recovery credentials' });
      }

      const normalizedCode = normalizeRecoveryCode(recoveryCode);
      const validCode = normalizedCode
        ? await bcrypt.compare(normalizedCode, user.recoveryCodeHash)
        : false;
      if (!validCode) {
        logAudit?.('recovery_reset_failed', user.id, null, 'invalid recovery code');
        return res.status(401).json({ message: 'Invalid recovery credentials' });
      }

      const nextRecoveryCode = generateRecoveryCode();
      const [hashedPassword, nextRecoveryCodeHash] = await Promise.all([
        bcrypt.hash(newPassword, 10),
        bcrypt.hash(nextRecoveryCode.normalizedCode, 10),
      ]);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          recoveryCodeHash: nextRecoveryCodeHash,
          recoveryCodeUpdatedAt: new Date(),
        },
      });
      logAudit?.('recovery_reset_success', user.id, null, 'password reset via recovery code');
      return res.status(200).json({
        message: 'Password reset successful. Save your new recovery code.',
        recoveryCode: nextRecoveryCode.displayCode,
      });
    } catch (err) {
      console.error('Recovery reset error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  return { verifyToken };
}

module.exports = { createAuthRoutes };
