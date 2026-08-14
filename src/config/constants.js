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
 * Anchored to the application root rather than left relative: a relative
 * `logs/combined.log` resolves against the *working directory*, so a systemd unit with
 * a different WorkingDirectory, or a developer running the sync from a subdirectory,
 * silently scattered log files or lost them entirely. See docs/decisions.md.
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
  // The version floor is the control that matters, and it is deliberately not paired
  // with a cipher allowlist: Node's `ciphers` option governs TLS 1.2 and below only, and
  // its default suite list is already modern. A hand-written list broke handshakes
  // against ECDSA certificates and bought nothing — see docs/decisions.md.
  TLS_MIN_VERSION: 'TLSv1.2',
  TLS_MAX_VERSION: 'TLSv1.3',

  // Validation Configuration
  MAX_ACCOUNT_NAME_LENGTH: 255,
  // Ghostfolio account ids are generated identifiers (UUID/cuid shaped). The value
  // is interpolated into the request path, so it is bounded and character-checked
  // rather than trusted because it came from the server.
  MAX_ACCOUNT_ID_LENGTH: 64,
  // Upper bound on a balance in minor units, i.e. ten billion in major units.
  //
  // No realistic personal account reaches this, and a value that does is a
  // corrupted read rather than a balance: Actual Budget stores minor units as
  // integers, so a misread field or a units mix-up shows up as an absurd
  // magnitude. Bounding it here means such a value fails the *fetch*, before any
  // of it reaches Ghostfolio.
  MAX_BALANCE_MINOR_UNITS: 1e12,
  // Balances are compared in major units after rounding to cents, so two values
  // closer than half a cent are the same stored value. Used to decide whether a
  // write would change anything, and to check what the server echoed back.
  BALANCE_EPSILON: 0.005,
  // Named like strength controls, so they have to behave like them — see
  // docs/decisions.md. A Ghostfolio access token is a generated UUID (36 characters),
  // so the token floor rejects typos and truncated copy-pastes without rejecting any
  // real token.
  MIN_PASSWORD_LENGTH: 8,
  MIN_TOKEN_LENGTH: 16,
  // A per-account factor converts units (cents to euros, shares to a valuation).
  // Anything past this is a typo — an extra zero on a balance is a number a
  // financial API should not be asked to store.
  MAX_BALANCE_FACTOR: 1000,
};
