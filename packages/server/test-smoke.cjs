const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const io = require('socket.io-client');
const { EVENTS, HEARTBEAT, HEARTBEAT_TIMEOUT_REASON } = require('../shared/protocol');

const SERVER_ROOT = path.resolve(__dirname);
const SERVER_ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');
const TEST_DB_SUFFIX = `${Date.now()}-${process.pid}`;
const TEST_DB_PATH = path.join(SERVER_ROOT, 'prisma', `smoke-test-${TEST_DB_SUFFIX}.db`);
const SERVER_URL = 'http://127.0.0.1:3001';
const CLIENT_HEARTBEAT_MS = Math.max(1000, Math.floor(HEARTBEAT.INTERVAL_MS / 2));
const SERVER_ENV = {
  PORT: '3001',
  JWT_SECRET: 'smoke-test-secret',
  DATABASE_URL: `file:${TEST_DB_PATH}`,
  CORS_ORIGIN: '*',
  USE_INSECURE_DEFAULT: 'false',
  LIFECYCLE_DEBUG: 'true',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOutput(proc, matcher, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for output: ${matcher}`));
    }, timeoutMs);

    const onData = (buffer) => {
      const text = buffer.toString();
      if (typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text)) {
        clearTimeout(timeout);
        proc.stdout.off('data', onData);
        resolve(text);
      }
    };

    proc.stdout.on('data', onData);
  });
}

function startServer() {
  const env = {
    ...process.env,
    ...SERVER_ENV,
  };
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  proc.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  return proc;
}

async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => proc.once('exit', () => resolve(true))),
    sleep(5000).then(() => false),
  ]);
  if (!exited) {
    proc.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => proc.once('exit', () => resolve(true))),
      sleep(2000),
    ]);
  }
}

function runPrismaMigrateDeploy() {
  const env = {
    ...process.env,
    ...SERVER_ENV,
  };
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: SERVER_ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function runPrismaGenerate() {
  const env = {
    ...process.env,
    ...SERVER_ENV,
  };
  const result = spawnSync('npx', ['prisma', 'generate'], {
    cwd: SERVER_ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma generate failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function registerAndLogin(username, password) {
  const registerResponse = await fetch(`${SERVER_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!registerResponse.ok && registerResponse.status !== 409) {
    const body = await registerResponse.text();
    throw new Error(`register failed (${registerResponse.status}): ${body}`);
  }

  const loginResponse = await fetch(`${SERVER_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!loginResponse.ok) {
    const body = await loginResponse.text();
    throw new Error(`login failed (${loginResponse.status}): ${body}`);
  }

  const data = await loginResponse.json();
  if (!data?.token) {
    throw new Error('login response did not include token');
  }
  return data.token;
}

function createAuthSocket(clientId, token) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
    });
    let ackSessionId = null;

    const onFail = (message) => {
      socket.removeAllListeners();
      socket.disconnect();
      reject(new Error(message));
    };

    socket.on('connect_error', (err) => onFail(`connect_error: ${err.message || err}`));
    socket.on(EVENTS.AUTH_ERROR, (msg) => onFail(`auth_error: ${msg}`));
    socket.on('connect', () => {
      socket.emit(EVENTS.HELLO, { clientId, clientVersion: 'smoke-harness' });
    });
    socket.on(EVENTS.HELLO_ACK, ({ sessionId }) => {
      ackSessionId = sessionId;
      socket.emit(EVENTS.AUTHENTICATE, token);
    });
    socket.on(EVENTS.AUTH_SUCCESS, (user) => {
      const pingTimer = setInterval(() => {
        if (!socket.connected) return;
        socket.emit(EVENTS.PING, { clientTime: Date.now() });
      }, CLIENT_HEARTBEAT_MS);
      socket.on('disconnect', () => clearInterval(pingTimer));
      resolve({
        socket,
        user,
        sessionId: ackSessionId,
        stopHeartbeat: () => clearInterval(pingTimer),
      });
    });
  });
}

async function expectEvent(socket, eventName, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for event ${eventName}`));
    }, timeoutMs);
    const handler = (payload) => {
      try {
        if (!predicate || predicate(payload)) {
          clearTimeout(timer);
          socket.off(eventName, handler);
          resolve(payload);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.off(eventName, handler);
        reject(error);
      }
    };
    socket.on(eventName, handler);
  });
}

async function addBuddy(token, buddyUsername) {
  const response = await fetch(`${SERVER_URL}/buddies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: buddyUsername }),
  });
  if (!response.ok && response.status !== 400) {
    const body = await response.text();
    throw new Error(`addBuddy failed (${response.status}): ${body}`);
  }
}

async function createSpace(token, name) {
  const response = await fetch(`${SERVER_URL}/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`createSpace failed (${response.status}): ${body}`);
  }
  return response.json();
}

async function run() {
  console.log('[smoke] starting smoke harness (Milestone 1 + connectivity scenarios)');
  const runningServers = [];
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { force: true });
  }
  if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.rmSync(`${TEST_DB_PATH}-wal`, { force: true });
  if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.rmSync(`${TEST_DB_PATH}-shm`, { force: true });
  runPrismaGenerate();
  runPrismaMigrateDeploy();
  const serverProcess = startServer();
  runningServers.push(serverProcess);

  try {
    await waitForOutput(serverProcess, /listening on http:\/\/localhost:3001/i, 25000);

    const token1 = await registerAndLogin('smokeuser1', 'smoke-pass-1');
    const token2 = await registerAndLogin('smokeuser2', 'smoke-pass-2');
    const token3 = await registerAndLogin('smokeuser3', 'smoke-pass-3');

    // ── Buddy API: mutual add so each user sees the other online ───────────
    await addBuddy(token1, 'smokeuser2');
    await addBuddy(token2, 'smokeuser1');
    console.log('[smoke] ✓ buddy API: mutual add');

    // ── Registration input validation ──────────────────────────────────────
    const badUserRes = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bad user!', password: 'validpassword' }),
    });
    if (badUserRes.status !== 400) throw new Error(`Expected 400 for invalid username, got ${badUserRes.status}`);
    console.log('[smoke] ✓ registration: invalid username rejected');

    const shortPassRes = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'validuser', password: 'short' }),
    });
    if (shortPassRes.status !== 400) throw new Error(`Expected 400 for short password, got ${shortPassRes.status}`);
    console.log('[smoke] ✓ registration: short password rejected');

    // ── Recovery flow + discovery gate ─────────────────────────────────────
    const recoveryUserRes = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'recoverable1', password: 'recoverable-pass-1' }),
    });
    if (!recoveryUserRes.ok) {
      throw new Error(`Expected recovery registration success, got ${recoveryUserRes.status}`);
    }
    const recoveryUserData = await recoveryUserRes.json();
    if (!recoveryUserData?.recoveryCode) {
      throw new Error('Expected register response to include recoveryCode');
    }
    const recoveryResetRes = await fetch(`${SERVER_URL}/recovery/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'recoverable1',
        recoveryCode: recoveryUserData.recoveryCode,
        newPassword: 'recoverable-pass-2',
      }),
    });
    if (!recoveryResetRes.ok) {
      const text = await recoveryResetRes.text();
      throw new Error(`Expected recovery reset success, got ${recoveryResetRes.status}: ${text}`);
    }
    const recoveryResetData = await recoveryResetRes.json();
    if (!recoveryResetData?.recoveryCode) {
      throw new Error('Expected reset response to rotate recoveryCode');
    }
    const oldLoginRes = await fetch(`${SERVER_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'recoverable1', password: 'recoverable-pass-1' }),
    });
    if (oldLoginRes.status !== 401) {
      throw new Error(`Expected old password login to fail with 401, got ${oldLoginRes.status}`);
    }
    const newLoginRes = await fetch(`${SERVER_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'recoverable1', password: 'recoverable-pass-2' }),
    });
    if (!newLoginRes.ok) {
      throw new Error(`Expected new password login to succeed, got ${newLoginRes.status}`);
    }
    const discoveryDisabledRes = await fetch(`${SERVER_URL}/users/search?q=smoke`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    if (discoveryDisabledRes.status !== 403) {
      throw new Error(`Expected /users/search to be disabled by default (403), got ${discoveryDisabledRes.status}`);
    }
    console.log('[smoke] ✓ recovery reset flow + discovery gate default off');

    const client1 = await createAuthSocket('smoke-client-1', token1);
    const client2 = await createAuthSocket('smoke-client-2', token2);
    const client3 = await createAuthSocket('smoke-client-3', token3);

    if (!client1.sessionId || !client2.sessionId || !client3.sessionId) {
      throw new Error('Expected HELLO_ACK session IDs for all clients');
    }

    // ── Authorization: spaces join boundary ───────────────────────────────
    const space = await createSpace(token2, 'smoke-space');
    const joinDenied = await fetch(`${SERVER_URL}/spaces/${space.id}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token3}` },
    });
    if (joinDenied.status !== 403) throw new Error(`Expected 403 for unauthorized space join, got ${joinDenied.status}`);
    const joinAllowed = await fetch(`${SERVER_URL}/spaces/${space.id}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}` },
    });
    if (!joinAllowed.ok) throw new Error(`Expected successful space join for buddy, got ${joinAllowed.status}`);
    console.log('[smoke] ✓ spaces: unauthorized join denied, buddy join allowed');

    // ── Authorization: messaging boundaries (REST + socket) ───────────────
    const forbiddenMessages = await fetch(`${SERVER_URL}/messages/${client3.user.id}`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    if (forbiddenMessages.status !== 403) {
      throw new Error(`Expected 403 for non-buddy message history, got ${forbiddenMessages.status}`);
    }
    const blockedMessagePromise = expectEvent(
      client1.socket,
      EVENTS.ERROR,
      (payload) => payload?.code === 'MESSAGE_FORBIDDEN',
      10000,
    );
    client1.socket.emit(EVENTS.MESSAGE_SEND, { recipientId: client3.user.id, body: 'should be blocked' });
    await blockedMessagePromise;
    const deliveredMessagePromise = expectEvent(
      client2.socket,
      EVENTS.MESSAGE_RECEIVE,
      (payload) => payload?.senderId === client1.user.id && payload?.recipientId === client2.user.id,
      10000,
    );
    client1.socket.emit(EVENTS.MESSAGE_SEND, { recipientId: client2.user.id, body: 'allowed buddy message' });
    await deliveredMessagePromise;
    console.log('[smoke] ✓ messaging: non-buddy blocked and buddy allowed');

    // ── Endpoint + NAT capability reporting ───────────────────────────────
    client1.socket.emit(EVENTS.CLIENT_INFO, {
      localEndpoint: { host: '192.168.0.10', port: 5555 },
      nat: { upnp: false, natPmp: false, relayEligible: true },
    });
    client2.socket.emit(EVENTS.CLIENT_INFO, {
      localEndpoint: { host: '192.168.0.11', port: 5556 },
      nat: { upnp: true, natPmp: false, relayEligible: true, strategy: 'upnp-assist' },
      publicEndpoint: { host: '1.2.3.4', port: 5556 },
    });
    console.log('[smoke] ✓ CLIENT_INFO with upnp-assist strategy accepted');

    // ── Download request → approve flow ───────────────────────────────────
    const sharedRef1 = 'a1b2c3d4e5f60708';
    const downloadRequestEvent = expectEvent(
      client2.socket,
      EVENTS.DOWNLOAD_REQUEST,
      (payload) => payload?.filePath === sharedRef1,
      15000,
    );
    client1.socket.emit(EVENTS.REQUEST_DOWNLOAD, {
      fromUserId: client2.user.id,
      filePath: sharedRef1,
    });
    const dlReq = await downloadRequestEvent;
    const downloadApprovedEvent = expectEvent(
      client1.socket,
      EVENTS.DOWNLOAD_APPROVED,
      (payload) => payload?.filePath === sharedRef1,
      15000,
    );
    client2.socket.emit(EVENTS.DOWNLOAD_APPROVE, {
      requesterId: dlReq.requesterId,
      filePath: sharedRef1,
    });
    await downloadApprovedEvent;
    console.log('[smoke] ✓ download request → approve flow');

    // ── Download approve with downloadToken is forwarded ───────────────────
    const sharedRefToken = 'a1b2c3d4e5f60709';
    const dlReqTokenEvent = expectEvent(
      client2.socket,
      EVENTS.DOWNLOAD_REQUEST,
      (payload) => payload?.filePath === sharedRefToken,
      15000,
    );
    client1.socket.emit(EVENTS.REQUEST_DOWNLOAD, {
      fromUserId: client2.user.id,
      filePath: sharedRefToken,
    });
    const dlReqToken = await dlReqTokenEvent;
    const downloadApprovedTokenEvent = expectEvent(
      client1.socket,
      EVENTS.DOWNLOAD_APPROVED,
      (payload) => payload?.filePath === sharedRefToken && payload?.downloadToken === 'mock-per-transfer-token',
      15000,
    );
    client2.socket.emit(EVENTS.DOWNLOAD_APPROVE, {
      requesterId: dlReqToken.requesterId,
      filePath: sharedRefToken,
      downloadToken: 'mock-per-transfer-token',
    });
    await downloadApprovedTokenEvent;
    console.log('[smoke] ✓ download approve: downloadToken forwarded in DOWNLOAD_APPROVED');

    // ── Download request → reject flow ────────────────────────────────────
    const sharedRef2 = 'deadbeefcafebabe';
    const downloadRequestEvent2 = expectEvent(
      client2.socket,
      EVENTS.DOWNLOAD_REQUEST,
      (payload) => payload?.filePath === sharedRef2,
      15000,
    );
    client1.socket.emit(EVENTS.REQUEST_DOWNLOAD, {
      fromUserId: client2.user.id,
      filePath: sharedRef2,
    });
    const dlReq2 = await downloadRequestEvent2;
    const downloadRejectedEvent = expectEvent(
      client1.socket,
      EVENTS.DOWNLOAD_REJECTED,
      (payload) => payload?.filePath === sharedRef2,
      15000,
    );
    client2.socket.emit(EVENTS.DOWNLOAD_REJECT, {
      requesterId: dlReq2.requesterId,
      filePath: sharedRef2,
    });
    await downloadRejectedEvent;
    console.log('[smoke] ✓ download request → reject flow');

    // ── File send approval workflow ────────────────────────────────────────
    const fileSendRequested = expectEvent(
      client2.socket,
      EVENTS.FILE_SEND_REQUESTED,
      (payload) => payload?.fileName === 'hello.txt' && payload?.requestId,
      15000,
    );
    client1.socket.emit(EVENTS.FILE_SEND_REQUEST, {
      recipientId: client2.user.id,
      fileName: 'hello.txt',
      fileData: Buffer.from('hello').toString('base64'),
      fileSize: 5,
    });
    const reqPayload = await fileSendRequested;
    const fileIncoming = expectEvent(
      client2.socket,
      EVENTS.FILE_INCOMING,
      (payload) => payload?.fileName === 'hello.txt',
      15000,
    );
    const fileApproved = expectEvent(
      client1.socket,
      EVENTS.FILE_SEND_APPROVED,
      (payload) => payload?.requestId === reqPayload.requestId,
      15000,
    );
    client2.socket.emit(EVENTS.FILE_SEND_APPROVE, { requestId: reqPayload.requestId });
    await Promise.all([fileIncoming, fileApproved]);
    console.log('[smoke] ✓ file send approval workflow');

    // ── File send: senderId included in FILE_SEND_REQUESTED ───────────────
    if (reqPayload.senderId === undefined) {
      throw new Error('FILE_SEND_REQUESTED missing senderId for trust-policy UX');
    }
    console.log('[smoke] ✓ FILE_SEND_REQUESTED includes senderId');

    // ── Relay protocol: full round-trip through broker ─────────────────────
    const relayId = `smoke-relay-${randomUUID()}`;
    const fileData = Buffer.from('relay test content').toString('base64');

    // client2 will serve; client1 will request
    const relayServeEvent = expectEvent(
      client2.socket,
      EVENTS.RELAY_SERVE,
      (payload) => payload?.relayId === relayId && payload?.filePath === '/shared/relay.dat',
      10000,
    );
    const relayDoneEvent = expectEvent(
      client1.socket,
      EVENTS.RELAY_DONE,
      (payload) => payload?.relayId === relayId,
      10000,
    );
    client1.socket.emit(EVENTS.RELAY_REQUEST, {
      relayId,
      ownerId: client2.user.id,
      filePath: '/shared/relay.dat',
      byteOffset: 0,
    });
    const servePayload = await relayServeEvent;
    // Simulate client2 uploading chunks
    client2.socket.emit(EVENTS.RELAY_CHUNK, { relayId: servePayload.relayId, data: fileData, offset: 0 });
    client2.socket.emit(EVENTS.RELAY_END, {
      relayId: servePayload.relayId,
      fileName: 'relay.dat',
      totalBytes: 18,
    });
    const donePayload = await relayDoneEvent;
    if (donePayload.error) throw new Error(`Relay ended with error: ${donePayload.error}`);
    console.log('[smoke] ✓ relay protocol: full round-trip');

    // ── Relay protocol: owner disconnect mid-relay sends RELAY_DONE error ──
    const relayId2 = `smoke-relay-2-${randomUUID()}`;
    const relayServeEvent2 = expectEvent(
      client2.socket,
      EVENTS.RELAY_SERVE,
      (payload) => payload?.relayId === relayId2,
      10000,
    );
    const relayDoneAbortEvent = expectEvent(
      client1.socket,
      EVENTS.RELAY_DONE,
      (payload) => payload?.relayId === relayId2 && payload?.error,
      15000,
    );
    client1.socket.emit(EVENTS.RELAY_REQUEST, {
      relayId: relayId2,
      ownerId: client2.user.id,
      filePath: '/shared/large.dat',
      byteOffset: 0,
    });
    await relayServeEvent2;
    // Disconnect client2 before sending RELAY_END to trigger abort path
    client2.stopHeartbeat();
    client2.socket.disconnect();
    await relayDoneAbortEvent;
    console.log('[smoke] ✓ relay protocol: owner disconnect mid-relay emits RELAY_DONE error');

    console.log('[smoke] ✓ two clients connect');

    client1.stopHeartbeat();
    client2.stopHeartbeat();
    client3.stopHeartbeat();
    client1.socket.disconnect();
    client2.socket.disconnect();
    client3.socket.disconnect();
    await stopServer(serverProcess);
    runningServers.pop();
    await sleep(1000);

    const restarted = startServer();
    runningServers.push(restarted);
    await waitForOutput(restarted, /listening on http:\/\/localhost:3001/i, 25000);

    const client1Reconnected = await createAuthSocket('smoke-client-1', token1);
    const reconnectPromise = expectEvent(
      client1Reconnected.socket,
      EVENTS.PEER_ONLINE,
      (payload) => payload?.clientId === 'smoke-client-2',
      15000,
    );
    const client2Reconnected = await createAuthSocket('smoke-client-2', token2);
    await reconnectPromise;
    console.log('[smoke] ✓ broker restart recovery');

    const staleOfflinePromise = expectEvent(
      client1Reconnected.socket,
      EVENTS.PEER_OFFLINE,
      (payload) => payload?.clientId === 'smoke-client-stale' && payload?.reason === HEARTBEAT_TIMEOUT_REASON,
      HEARTBEAT.TIMEOUT_MS + HEARTBEAT.SWEEP_INTERVAL_MS + 15000,
    );
    const staleSocket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
    });
    staleSocket.on('connect', () => {
      staleSocket.emit(EVENTS.HELLO, { clientId: 'smoke-client-stale', clientVersion: 'smoke-harness' });
    });
    await expectEvent(staleSocket, EVENTS.HELLO_ACK, Boolean, 10000);
    await staleOfflinePromise;
    console.log('[smoke] ✓ stale client offline detection');

    staleSocket.disconnect();
    client1Reconnected.stopHeartbeat();
    client2Reconnected.stopHeartbeat();
    client1Reconnected.socket.disconnect();
    client2Reconnected.socket.disconnect();
    await stopServer(restarted);
    runningServers.pop();
    console.log('[smoke] PASS');
  } catch (error) {
    console.error('[smoke] FAIL', error);
    process.exitCode = 1;
  } finally {
    while (runningServers.length > 0) {
      const proc = runningServers.pop();
      await stopServer(proc);
    }
  }
}

run();
