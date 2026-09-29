/**
 * Minimal sanity tests for packages/shared/protocol.js
 *
 * Run with: node packages/shared/test-protocol.cjs
 */

'use strict';

const { PROTOCOL_VERSION, HEARTBEAT, EVENTS, validateMessage } = require('./protocol');

let passed = 0;
let failed = 0;

function assert(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertValid(description, eventName, payload) {
  const result = validateMessage(eventName, payload);
  if (result.valid) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — ${result.error}`);
    failed++;
  }
}

function assertInvalid(description, eventName, payload) {
  const result = validateMessage(eventName, payload);
  if (!result.valid) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected invalid but got valid`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------
console.log('\nProtocol version:');
assert('PROTOCOL_VERSION is 1', PROTOCOL_VERSION, 1);

// ---------------------------------------------------------------------------
// Heartbeat constants
// ---------------------------------------------------------------------------
console.log('\nHeartbeat constants:');
assert('HEARTBEAT.INTERVAL_MS is a positive number', typeof HEARTBEAT.INTERVAL_MS === 'number' && HEARTBEAT.INTERVAL_MS > 0, true);
assert('HEARTBEAT.TIMEOUT_MS > HEARTBEAT.INTERVAL_MS', HEARTBEAT.TIMEOUT_MS > HEARTBEAT.INTERVAL_MS, true);
assert('HEARTBEAT.SWEEP_INTERVAL_MS is positive', typeof HEARTBEAT.SWEEP_INTERVAL_MS === 'number' && HEARTBEAT.SWEEP_INTERVAL_MS > 0, true);
assert('HEARTBEAT.DISCONNECTED_CLEANUP_MS >= HEARTBEAT.TIMEOUT_MS', HEARTBEAT.DISCONNECTED_CLEANUP_MS >= HEARTBEAT.TIMEOUT_MS, true);

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------
console.log('\nEvent name constants:');
assert('EVENTS.AUTHENTICATE is "authenticate"', EVENTS.AUTHENTICATE, 'authenticate');
assert('EVENTS.SHARE_FILES is "share:files"', EVENTS.SHARE_FILES, 'share:files');
assert('EVENTS.AUTH_SUCCESS is "auth:success"', EVENTS.AUTH_SUCCESS, 'auth:success');
assert('EVENTS.AUTH_ERROR is "auth:error"', EVENTS.AUTH_ERROR, 'auth:error');
assert('EVENTS.USER_ONLINE is "user:online"', EVENTS.USER_ONLINE, 'user:online');
assert('EVENTS.USER_OFFLINE is "user:offline"', EVENTS.USER_OFFLINE, 'user:offline');
assert('EVENTS.PING is "ping"', EVENTS.PING, 'ping');
assert('EVENTS.PONG is "pong"', EVENTS.PONG, 'pong');
assert('EVENTS.HELLO is "hello"', EVENTS.HELLO, 'hello');
assert('EVENTS.HELLO_ACK is "hello:ack"', EVENTS.HELLO_ACK, 'hello:ack');
assert('EVENTS.ERROR is "error"', EVENTS.ERROR, 'error');
assert('EVENTS.CLIENT_INFO is "client:info"', EVENTS.CLIENT_INFO, 'client:info');
assert('EVENTS.FILE_SEND_REQUEST is "file:send:request"', EVENTS.FILE_SEND_REQUEST, 'file:send:request');
assert('EVENTS.FILE_SEND_APPROVE is "file:send:approve"', EVENTS.FILE_SEND_APPROVE, 'file:send:approve');
assert('EVENTS.FILE_SEND_REJECT is "file:send:reject"', EVENTS.FILE_SEND_REJECT, 'file:send:reject');
assert('EVENTS.ROOM_JOIN is "room:join"', EVENTS.ROOM_JOIN, 'room:join');
assert('EVENTS.ROOM_MESSAGE_SEND is "room:message:send"', EVENTS.ROOM_MESSAGE_SEND, 'room:message:send');

// ---------------------------------------------------------------------------
// validateMessage – valid cases
// ---------------------------------------------------------------------------
console.log('\nvalidateMessage – valid payloads:');
assertValid('authenticate with valid token', EVENTS.AUTHENTICATE, 'valid.jwt.token');
assertValid('share:files with array', EVENTS.SHARE_FILES, [{ name: 'file.txt', type: 'file', size: 100, path: '/tmp/file.txt' }]);
assertValid('share:files with empty array', EVENTS.SHARE_FILES, []);
assertValid('request:download with valid payload', EVENTS.REQUEST_DOWNLOAD, { fromUserId: 1, filePath: '/tmp/a.txt' });
assertValid('download:approve with valid payload', EVENTS.DOWNLOAD_APPROVE, { requesterId: 'socket-abc', filePath: '/tmp/a.txt' });
assertValid('download:approve with optional downloadToken', EVENTS.DOWNLOAD_APPROVE, { requesterId: 'socket-abc', filePath: '/tmp/a.txt', downloadToken: 'abc123token' });
assertValid('download:reject with valid payload', EVENTS.DOWNLOAD_REJECT, { requesterId: 'socket-abc', filePath: '/tmp/a.txt' });
assertValid('file:send with valid payload', EVENTS.FILE_SEND, { recipientId: 2, fileName: 'photo.jpg', fileData: 'base64data', fileSize: 1024 });
assertValid('client:info with valid payload', EVENTS.CLIENT_INFO, {
  localEndpoint: { host: '192.168.1.10', port: 5555 },
  publicEndpoint: { host: '203.0.113.2', port: 45555 },
  nat: { upnp: true, natPmp: false, relayEligible: true },
});
assertValid('file:send:request with valid payload', EVENTS.FILE_SEND_REQUEST, {
  recipientId: 2,
  fileName: 'photo.jpg',
  fileData: 'base64data',
  fileSize: 1024,
});
assertValid('file:send:approve with valid payload', EVENTS.FILE_SEND_APPROVE, { requestId: 'req-1' });
assertValid('file:send:reject with valid payload', EVENTS.FILE_SEND_REJECT, { requestId: 'req-1' });
assertValid('transfer:connectivity:report with valid payload', EVENTS.TRANSFER_CONNECTIVITY_REPORT, {
  transferId: 'tx-1',
  status: 'direct-success',
});
assertValid('room:join with valid payload', EVENTS.ROOM_JOIN, { spaceId: 'space-1' });
assertValid('room:message:send with valid payload', EVENTS.ROOM_MESSAGE_SEND, { spaceId: 'space-1', body: 'hello room' });
assertValid('unknown event passes through', 'refresh:users', undefined);

// ---------------------------------------------------------------------------
// validateMessage – invalid cases
// ---------------------------------------------------------------------------
console.log('\nvalidateMessage – invalid payloads (should be rejected):');
assertInvalid('authenticate with empty string', EVENTS.AUTHENTICATE, '');
assertInvalid('authenticate with number', EVENTS.AUTHENTICATE, 42);
assertInvalid('share:files with non-array', EVENTS.SHARE_FILES, { files: [] });
assertInvalid('request:download missing filePath', EVENTS.REQUEST_DOWNLOAD, { fromUserId: 1 });
assertInvalid('request:download missing fromUserId', EVENTS.REQUEST_DOWNLOAD, { filePath: '/a.txt' });
assertInvalid('request:download invalid fromUserId type', EVENTS.REQUEST_DOWNLOAD, { fromUserId: '1', filePath: '/a.txt' });
assertInvalid('download:approve missing requesterId', EVENTS.DOWNLOAD_APPROVE, { filePath: '/a.txt' });
assertInvalid('download:approve with empty downloadToken', EVENTS.DOWNLOAD_APPROVE, { requesterId: 'socket-abc', filePath: '/a.txt', downloadToken: '' });
assertInvalid('download:approve with numeric downloadToken', EVENTS.DOWNLOAD_APPROVE, { requesterId: 'socket-abc', filePath: '/a.txt', downloadToken: 12345 });
assertInvalid('file:send missing fileName', EVENTS.FILE_SEND, { recipientId: 2, fileData: 'data' });
assertInvalid('client:info missing local endpoint', EVENTS.CLIENT_INFO, { publicEndpoint: { host: '1.1.1.1', port: 1234 } });
assertInvalid('client:info with invalid port', EVENTS.CLIENT_INFO, { localEndpoint: { host: '127.0.0.1', port: 0 } });
assertInvalid('file:send:request missing recipientId', EVENTS.FILE_SEND_REQUEST, { fileName: 'a', fileData: 'x' });
assertInvalid('file:send:approve missing requestId', EVENTS.FILE_SEND_APPROVE, {});
assertInvalid('transfer:connectivity:report missing status', EVENTS.TRANSFER_CONNECTIVITY_REPORT, { transferId: 'tx-1' });
assertInvalid('room:join missing spaceId', EVENTS.ROOM_JOIN, {});
assertInvalid('room:message:send missing body', EVENTS.ROOM_MESSAGE_SEND, { spaceId: 'space-1' });

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
