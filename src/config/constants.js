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

/**
 * Directory for Winston's file transports.
 *
 * Anchored to the application root rather than left relative: `logs/combined.log`
 * resolves against the *working directory*, so it only worked because the old
 * crontab entry did `cd /app` first. Any other caller — a systemd unit with a
 * different WorkingDirectory, a developer running the sync from a subdirectory —
 * silently scattered log files or lost them entirely.
 *
 * @returns {string} Absolute path to the log directory
 */
function logDir() {
  return process.env.GHOSTBUDGET_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
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
  logDir,
  // Upper bound on a logged error message. Remote errors can be enormous — an
  // HTML error page or a full API response — and an unbounded message both fills
  // the log and widens the window for something sensitive to slip through.
  MAX_ERROR_MESSAGE_LENGTH: 512,

  // Retry Configuration
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,

  // Scheduler Configuration
  //
  // This is the only wall-clock bound on a run, and it is a hard one: the
  // scheduler sends SIGTERM at this point and escalates to SIGKILL. Per-request
  // limits cannot substitute for it, because they bound one request chain
  // (HTTP_TIMEOUT_MS × (MAX_RETRIES + 1) plus backoff, so about 144 s) and a sync
  // makes one such chain per account — enough accounts retrying to exhaustion
  // would run for hours. Fifteen minutes is well past a healthy sync of any
  // realistic account list and well short of a run worth leaving alive.
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

  // TLS Configuration
  //
  // The version floor is the control that matters, and it is deliberately not
  // paired with a cipher allowlist. The previous list permitted only ECDHE-RSA
  // suites for TLS 1.2, which fails the handshake outright against a server
  // holding an ECDSA certificate — Let's Encrypt ECDSA and Cloudflare both issue
  // them — and its TLS 1.3 entries were inert, because Node's `ciphers` option
  // governs TLS 1.2 and below only (TLS 1.3 needs `ciphersuites`, which Node does
  // not expose). Node's default suite list is already modern and drops the weak
  // suites, so pinning bought nothing and broke real deployments.
  TLS_MIN_VERSION: 'TLSv1.2',
  TLS_MAX_VERSION: 'TLSv1.3',

  // Validation Configuration
  MAX_ACCOUNT_NAME_LENGTH: 255,
  // These are named like strength controls, so they have to behave like them: at
  // 1 they only rejected the empty string, and `ACTUAL_BUDGET_PASS=x` validated
  // happily. A Ghostfolio access token is a generated UUID (36 characters), so
  // the token floor rejects typos and truncated copy-pastes without rejecting any
  // real token.
  MIN_PASSWORD_LENGTH: 8,
  MIN_TOKEN_LENGTH: 16,
  // A per-account factor converts units (cents to euros, shares to a valuation).
  // Anything past this is a typo — an extra zero on a balance is a number a
  // financial API should not be asked to store.
  MAX_BALANCE_FACTOR: 1000,
};
