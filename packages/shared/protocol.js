'use strict';

/**
 * Orchard Shared Protocol Contract
 *
 * Single source of truth for:
 *  - Protocol version
 *  - Socket.IO event names (broker ↔ client)
 *  - Heartbeat timing defaults
 *  - Inbound message validation
 *
 * Location: packages/shared/protocol.js
 * Usage:
 *   // Node.js / broker (CommonJS)
 *   const { EVENTS, HEARTBEAT, PROTOCOL_VERSION, validateMessage } = require('../../shared/protocol');
 *
 *   // Electron / React client (Vite handles CJS → ESM interop)
 *   import { EVENTS, HEARTBEAT, PROTOCOL_VERSION } from '../../shared/protocol.js';
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Increment when a breaking change is made to the wire protocol. */
const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Heartbeat timing (milliseconds)
// ---------------------------------------------------------------------------

const HEARTBEAT = {
  /** How often the client sends a PING to the broker. */
  INTERVAL_MS: 15000,
  /** How long without a PING before the broker considers the client dead. */
  TIMEOUT_MS: 45000,
  /** How often the broker scans for stale sessions. */
  SWEEP_INTERVAL_MS: 10000,
  /** How long to keep a disconnected session before removing it from memory. */
  DISCONNECTED_CLEANUP_MS: 45000,
};

/** Canonical reason string emitted when stale sessions are marked offline. */
const HEARTBEAT_TIMEOUT_REASON = 'heartbeat-timeout';

// ---------------------------------------------------------------------------
// Socket.IO event names
// ---------------------------------------------------------------------------

const EVENTS = {
  // ── Client → Broker ─────────────────────────────────────────────────────
  /** Send JWT token immediately after WebSocket connection is established. */
  AUTHENTICATE:     'authenticate',
  /** Send the client's shared file tree to the broker. */
  SHARE_FILES:      'share:files',
  /** Ask the broker to refresh the online-buddies list. */
  REFRESH_USERS:    'refresh:users',
  /** Request to download a file from another peer. */
  REQUEST_DOWNLOAD: 'request:download',
  /** Approve an incoming download request. */
  DOWNLOAD_APPROVE: 'download:approve',
  /** Reject an incoming download request. */
  DOWNLOAD_REJECT:  'download:reject',
  /** Send a file payload directly to another peer via the broker. */
  FILE_SEND:        'file:send',
  /** Share client endpoint and NAT capabilities with the broker. */
  CLIENT_INFO:      'client:info',
  /** Request permission before sending a direct file payload. */
  FILE_SEND_REQUEST: 'file:send:request',
  /** Approve an incoming file-send request. */
  FILE_SEND_APPROVE: 'file:send:approve',
  /** Reject an incoming file-send request. */
  FILE_SEND_REJECT:  'file:send:reject',
  /** Transfer connectivity diagnostics from client. */
  TRANSFER_CONNECTIVITY_REPORT: 'transfer:connectivity:report',
  /** Requester asks broker to relay a file through the broker when direct HTTP fails. */
  RELAY_REQUEST: 'relay:request',
  /** Uploader sends a file chunk to the broker during relay. */
  RELAY_CHUNK: 'relay:chunk',
  /** Uploader signals completion or error during relay. */
  RELAY_END: 'relay:end',

  // ── Broker → Client ─────────────────────────────────────────────────────
  /** Authentication succeeded; payload is the authenticated user object. */
  AUTH_SUCCESS:      'auth:success',
  /** Authentication failed; payload is an error message string. */
  AUTH_ERROR:        'auth:error',
  /** Initial list of online buddies; payload is an array of client objects. */
  USERS_LIST:        'users:list',
  /** A buddy came online; payload is the client object. */
  USER_ONLINE:       'user:online',
  /** A buddy went offline; payload is the user object. */
  USER_OFFLINE:      'user:offline',
  /** A buddy's file list changed; payload is the updated client object. */
  USER_UPDATED:      'user:updated',
  /** File owner received a download request; payload: { requester, filePath, requesterId }. */
  DOWNLOAD_REQUEST:  'download:request',
  /** Download request was approved; payload: { filePath, ownerId, ownerUsername, ownerSocketId }. */
  DOWNLOAD_APPROVED: 'download:approved',
  /** Download request was rejected; payload: { filePath }. */
  DOWNLOAD_REJECTED: 'download:rejected',
  /** Generic download error; payload: { message }. */
  DOWNLOAD_ERROR:    'download:error',
  /** A peer sent a file directly; payload: { senderUsername, fileName, fileData, fileSize }. */
  FILE_INCOMING:     'file:incoming',
  /** File send request awaiting recipient action. */
  FILE_SEND_REQUESTED: 'file:send:requested',
  /** File send request approved by recipient. */
  FILE_SEND_APPROVED: 'file:send:approved',
  /** File send request rejected by recipient. */
  FILE_SEND_REJECTED: 'file:send:rejected',
  /** Broker asks the file owner to serve a file via relay. */
  RELAY_SERVE: 'relay:serve',
  /** Broker forwards a relay chunk from owner to requester. */
  RELAY_CHUNK_FWD: 'relay:chunk:fwd',
  /** Broker signals relay completion (or error) to the requester. */
  RELAY_DONE: 'relay:done',

  // ── Milestone 1 – reserved for near-term connectivity protocol ───────────
  /** Initial client handshake; payload: { clientId, username, clientVersion }. */
  HELLO:        'hello',
  /** Broker acknowledgement of HELLO; payload: { sessionId, serverTime }. */
  HELLO_ACK:    'hello:ack',
  /** Keepalive ping sent by client. */
  PING:         'ping',
  /** Keepalive pong replied by broker. */
  PONG:         'pong',
  /** Peer came online (future broadcast event name). */
  PEER_ONLINE:  'peer:online',
  /** Peer went offline (future broadcast event name). */
  PEER_OFFLINE: 'peer:offline',
  /** Generic protocol error from broker; payload: { code, message }. */
  ERROR:        'error',

  // ── Bidirectional buddy requests ─────────────────────────────────────────
  /** Broker → client: someone sent you a buddy request; payload: { requestId, from }. */
  BUDDY_REQUESTED: 'buddy:requested',
  /** Broker → client: your buddy request was accepted; payload: { friend }. */
  BUDDY_ACCEPTED:  'buddy:accepted',
  /** Broker → client: your buddy request was declined; payload: { toId }. */
  BUDDY_DECLINED:  'buddy:declined',

  // ── In-app 1:1 messaging ──────────────────────────────────────────────────
  /** Client → broker: send a message; payload: { recipientId, body }. */
  MESSAGE_SEND:    'message:send',
  /** Broker → client: receive a message; payload: { id, senderId, recipientId, body, createdAt }. */
  MESSAGE_RECEIVE: 'message:receive',

  // ── Space chat rooms (private-first) ───────────────────────────────────────
  /** Client joins the private room for a space they belong to. */
  ROOM_JOIN:       'room:join',
  /** Client leaves the private room for a space. */
  ROOM_LEAVE:      'room:leave',
  /** Client sends a message to a private space room. */
  ROOM_MESSAGE_SEND: 'room:message:send',
  /** Broker emits room message history after join. */
  ROOM_HISTORY:    'room:history',
  /** Broker emits a new private room message. */
  ROOM_MESSAGE:    'room:message',
};

// ---------------------------------------------------------------------------
// Inbound message validation
// ---------------------------------------------------------------------------

/**
 * Validate an inbound socket message received by the broker.
 *
 * @param {string} eventName - The Socket.IO event name.
 * @param {*}      payload   - The received payload.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateMessage(eventName, payload) {
  switch (eventName) {
    case EVENTS.HELLO:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.clientId !== 'string' ||
        !payload.clientId.trim() ||
        (payload.clientVersion !== undefined && typeof payload.clientVersion !== 'string')
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty clientId string and optional string clientVersion`,
        };
      }
      break;

    case EVENTS.AUTHENTICATE:
      if (typeof payload !== 'string' || !payload.trim()) {
        return { valid: false, error: `[protocol] ${eventName}: token must be a non-empty string` };
      }
      break;

    case EVENTS.PING:
      if (
        payload !== undefined &&
        (
          typeof payload !== 'object' ||
          payload === null ||
          (payload.clientTime !== undefined && !Number.isFinite(payload.clientTime))
        )
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: payload must be an object with optional numeric clientTime`,
        };
      }
      break;

    case EVENTS.SHARE_FILES:
      if (!Array.isArray(payload)) {
        return { valid: false, error: `[protocol] ${eventName}: payload must be an array` };
      }
      break;

    case EVENTS.REQUEST_DOWNLOAD:
      if (
        !payload ||
        typeof payload !== 'object' ||
        !Number.isInteger(payload.fromUserId) ||
        payload.fromUserId <= 0 ||
        typeof payload.filePath !== 'string' ||
        !payload.filePath.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires positive integer fromUserId and non-empty filePath string`,
        };
      }
      break;

    case EVENTS.DOWNLOAD_APPROVE:
    case EVENTS.DOWNLOAD_REJECT:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.requesterId !== 'string' ||
        !payload.requesterId.trim() ||
        typeof payload.filePath !== 'string' ||
        !payload.filePath.trim() ||
        (payload.downloadToken !== undefined &&
          (typeof payload.downloadToken !== 'string' || !payload.downloadToken.trim()))
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty requesterId string and filePath string`,
        };
      }
      break;

    case EVENTS.FILE_SEND:
      if (
        !payload ||
        typeof payload !== 'object' ||
        payload.recipientId === undefined ||
        typeof payload.fileName !== 'string' ||
        !payload.fileName.trim() ||
        typeof payload.fileData !== 'string'
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires recipientId, a non-empty fileName string, and fileData string`,
        };
      }
      break;

    case EVENTS.CLIENT_INFO:
      if (
        !payload ||
        typeof payload !== 'object' ||
        !payload.localEndpoint ||
        typeof payload.localEndpoint !== 'object' ||
        typeof payload.localEndpoint.host !== 'string' ||
        !payload.localEndpoint.host.trim() ||
        !Number.isInteger(payload.localEndpoint.port) ||
        payload.localEndpoint.port <= 0 ||
        payload.localEndpoint.port > 65535
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires localEndpoint { host, port }`,
        };
      }
      break;

    case EVENTS.FILE_SEND_REQUEST:
      if (
        !payload ||
        typeof payload !== 'object' ||
        payload.recipientId === undefined ||
        typeof payload.fileName !== 'string' ||
        !payload.fileName.trim() ||
        typeof payload.fileData !== 'string'
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires recipientId, non-empty fileName, and fileData string`,
        };
      }
      break;

    case EVENTS.FILE_SEND_APPROVE:
    case EVENTS.FILE_SEND_REJECT:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.requestId !== 'string' ||
        !payload.requestId.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty requestId string`,
        };
      }
      break;

    case EVENTS.TRANSFER_CONNECTIVITY_REPORT:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.transferId !== 'string' ||
        !payload.transferId.trim() ||
        typeof payload.status !== 'string' ||
        !payload.status.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty transferId and status strings`,
        };
      }
      break;

    case EVENTS.ROOM_JOIN:
    case EVENTS.ROOM_LEAVE:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.spaceId !== 'string' ||
        !payload.spaceId.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty spaceId string`,
        };
      }
      break;

    case EVENTS.ROOM_MESSAGE_SEND:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.spaceId !== 'string' ||
        !payload.spaceId.trim() ||
        typeof payload.body !== 'string' ||
        !payload.body.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty spaceId and body strings`,
        };
      }
      break;

    case EVENTS.RELAY_REQUEST:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.relayId !== 'string' ||
        !payload.relayId.trim() ||
        typeof payload.ownerId === 'undefined' ||
        typeof payload.filePath !== 'string' ||
        !payload.filePath.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty relayId, ownerId, and filePath`,
        };
      }
      break;

    case EVENTS.RELAY_CHUNK:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.relayId !== 'string' ||
        !payload.relayId.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty relayId`,
        };
      }
      break;

    case EVENTS.RELAY_END:
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.relayId !== 'string' ||
        !payload.relayId.trim()
      ) {
        return {
          valid: false,
          error: `[protocol] ${eventName}: requires non-empty relayId`,
        };
      }
      break;

    default:
      // Unknown or future events pass through – handled by the caller.
      break;
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { PROTOCOL_VERSION, HEARTBEAT, HEARTBEAT_TIMEOUT_REASON, EVENTS, validateMessage };
