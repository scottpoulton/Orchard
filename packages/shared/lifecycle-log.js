'use strict';

function normalizeNullable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return String(value);
}

function createLifecycleLog(payload = {}) {
  const {
    timestamp,
    clientId,
    sessionId,
    event,
    state,
    errorCode,
    ...extra
  } = payload;

  return {
    timestamp: timestamp ?? new Date().toISOString(),
    clientId: normalizeNullable(clientId),
    sessionId: normalizeNullable(sessionId),
    event: normalizeNullable(event) || 'unknown',
    state: normalizeNullable(state),
    errorCode: normalizeNullable(errorCode),
    ...extra,
  };
}

module.exports = {
  createLifecycleLog,
};
