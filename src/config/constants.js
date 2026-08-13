/**
 * Application constants
 * Centralized configuration values for the application
 */

const os = require('os');
const path = require('path');

// HTTP Configuration
const HTTP_TIMEOUT_MS = 30000; // 30 seconds, per attempt
const MAX_RETRIES = 3; // Maximum retry attempts

// Upper bound on a single retry backoff. axios-retry's exponentialDelay honours a
// server's Retry-After header, which is unbounded — a misconfigured or hostile
// server could otherwise stall a sync for minutes and make the total time of a
// request chain impossible to bound.
const MAX_RETRY_DELAY_MS = 8000;

// Headroom on top of the retry budget for rate-limiter queueing and scheduling.
const CIRCUIT_BREAKER_TIMEOUT_MARGIN_MS = 5000;

/**
 * Worst-case wall time for one fully-retried request chain, plus headroom.
 *
 * The circuit breaker wraps the whole axios-retry chain, so its timeout must
 * exceed that chain's worst case. If it does not, the breaker fires on requests
 * that are merely retrying: it records a failure, and — because opossum does not
 * cancel the action it wrapped — the in-flight request continues and can still
 * succeed, leaving the audit trail contradicting what actually happened.
 *
 * @param {number} maxRetries - Retries configured on the axios instance
 * @returns {number} Timeout in milliseconds
 */
function circuitBreakerTimeoutFor(maxRetries = MAX_RETRIES) {
  const attempts = maxRetries + 1;
  return (
    attempts * HTTP_TIMEOUT_MS + maxRetries * MAX_RETRY_DELAY_MS + CIRCUIT_BREAKER_TIMEOUT_MARGIN_MS
  );
}

/**
 * Location of the scheduler's health state file.
 *
 * Read by both the scheduler (writer) and the health check (reader), so it has
 * to be one shared definition. It lives in the temp directory rather than under
 * /app so the container filesystem can be mounted read-only; the override exists
 * for tests, which must not fight over a single fixed path.
 *
 * @returns {string} Absolute path to the health state file
 */
function healthStateFile() {
  return process.env.GHOSTBUDGET_HEALTH_FILE || path.join(os.tmpdir(), 'ghostbudget-health.json');
}

module.exports = {
  // HTTP Configuration
  HTTP_TIMEOUT_MS,
  MAX_CONTENT_LENGTH_BYTES: 10 * 1024 * 1024, // 10MB
  MAX_BODY_LENGTH_BYTES: 10 * 1024 * 1024, // 10MB

  // Logging Configuration
  LOG_MAX_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  LOG_MAX_FILES: 5,
  LOG_FLUSH_TIMEOUT_MS: 2000, // Bound the wait for Winston to flush on exit

  // Performance Configuration
  BATCH_SIZE: 10, // Process accounts in batches of 10
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,

  // Scheduler Configuration
  // A sync that has not finished in 15 minutes is wedged: the whole request
  // budget for one account is bounded by circuitBreakerTimeoutFor() above, so
  // even a fully-retrying sync of 50 accounts finishes well inside this.
  SYNC_TIMEOUT_MS: 15 * 60 * 1000,
  SYNC_SIGKILL_GRACE_MS: 10 * 1000, // Grace between SIGTERM and SIGKILL
  HEARTBEAT_INTERVAL_MS: 30 * 1000,
  // Three missed heartbeats. Tolerates one slow write without reporting a
  // healthy scheduler as dead.
  HEALTH_MAX_STALE_MS: 90 * 1000,
  // Kept under Docker's 10 s default stop timeout so an in-flight sync is asked
  // to stop, and the scheduler still exits on its own terms, before SIGKILL.
  SHUTDOWN_GRACE_MS: 8 * 1000,
  healthStateFile,

  // Rate Limiting Configuration
  RATE_LIMIT_POINTS: 10, // 10 requests
  RATE_LIMIT_DURATION: 1, // per 1 second
  RATE_LIMIT_MAX_QUEUE: 100, // Requests may wait for a slot rather than failing

  // Circuit Breaker Configuration
  CIRCUIT_BREAKER_TIMEOUT_MARGIN_MS,
  circuitBreakerTimeoutFor,
  CIRCUIT_BREAKER_ERROR_THRESHOLD: 50, // 50% error rate
  CIRCUIT_BREAKER_RESET_TIMEOUT: 30000, // 30 seconds

  // TLS Configuration
  TLS_MIN_VERSION: 'TLSv1.2',
  TLS_MAX_VERSION: 'TLSv1.3',
  TLS_CIPHERS: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
  ].join(':'),

  // Validation Configuration
  MAX_ACCOUNT_NAME_LENGTH: 255,
  MIN_PASSWORD_LENGTH: 1,
  MIN_TOKEN_LENGTH: 1,
};
