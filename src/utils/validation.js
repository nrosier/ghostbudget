const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const logger = require('../logger');
const AuditLogger = require('./audit');
const constants = require('../config/constants');

/**
 * Paths that must never be used as the Actual Budget data directory.
 *
 * The container entrypoint used to run `chown -R` against this value as root, so
 * `ACTUAL_BUDGET_DATA_DIR=/` rewrote ownership across the whole filesystem. That
 * chown is gone — the container no longer has a root phase — but the value still
 * decides where a SQLite database is created and where the process demands write
 * access, so pointing it at a system directory is never what an operator meant.
 */
const PROTECTED_DATA_DIRS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
]);

/**
 * Schema for validating config.json structure
 */
const configSchema = Joi.object({
  accounts: Joi.array()
    .items(
      Joi.object({
        ghostfolioName: Joi.string().trim().min(1).max(255).required(),
        actualBudgetName: Joi.string().trim().min(1).max(255).required(),
        factor: Joi.number().positive().default(1),
      })
    )
    .min(1)
    .required(),
}).required();

/**
 * Schema for validating environment variables
 */
const envSchema = Joi.object({
  ACTUAL_BUDGET_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/^https?:\/\/(localhost|127\.0\.0\.1|[\w\-\.]+\.[a-z]{2,})/)
    .required(),
  ACTUAL_BUDGET_PASS: Joi.string().min(constants.MIN_PASSWORD_LENGTH).required(),
  ACTUAL_BUDGET_SYNC_ID: Joi.string().min(1).required(),
  ACTUAL_BUDGET_DATA_DIR: Joi.string().allow('').optional(),
  GHOSTFOLIO_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/^https?:\/\/(localhost|127\.0\.0\.1|[\w\-\.]+\.[a-z]{2,})/)
    .required(),
  GHOSTFOLIO_TOKEN: Joi.string().min(constants.MIN_TOKEN_LENGTH).required(),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),
  // CACHE_TTL_MINUTES and BATCH_SIZE are both gone, for the same reason: each
  // configured something that could not take effect in a one-shot process — a
  // cache that never served a read, and batches over a synchronous local database.
  // Unknown variables are allowed, so an operator who still has either set in a
  // .env file sees no error; it simply does nothing, as before.
  MAX_RETRIES: Joi.number().integer().min(0).max(10).default(3),
}).unknown(true); // Allow other env vars

/**
 * Validate configuration object
 * @param {Object} config - Configuration object to validate
 * @returns {Object} Validated and sanitized configuration
 * @throws {Error} If validation fails
 */
function validateConfig(config) {
  const { error, value } = configSchema.validate(config, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const details = error.details.map((d) => d.message).join('; ');
    logger.error('Configuration validation failed', { details });
    throw new Error(`Invalid configuration: ${details}`);
  }

  logger.debug('Configuration validated successfully');
  return value;
}

/**
 * Validate environment variables
 * @param {Object} env - Environment variables object (typically process.env)
 * @returns {Object} Validated environment variables
 * @throws {Error} If validation fails
 */
function validateEnvironment(env) {
  const { error, value } = envSchema.validate(env, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const details = error.details.map((d) => d.message).join('; ');
    logger.error('Environment validation failed', { details });
    AuditLogger.logValidationFailure('environment', { details });
    throw new Error(`Invalid environment variables: ${details}`);
  }

  // Validate URLs are HTTPS in production
  if (value.NODE_ENV === 'production') {
    if (!value.ACTUAL_BUDGET_URL.startsWith('https://')) {
      throw new Error('ACTUAL_BUDGET_URL must use HTTPS in production');
    }
    if (!value.GHOSTFOLIO_URL.startsWith('https://')) {
      throw new Error('GHOSTFOLIO_URL must use HTTPS in production');
    }
  }

  logger.debug('Environment variables validated successfully');
  return value;
}

/**
 * Validate account balance
 * @param {*} balance - Balance value to validate
 * @returns {number} Validated balance
 * @throws {Error} If validation fails
 */
function validateBalance(balance) {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    throw new Error(`Invalid balance: must be a finite number, got ${typeof balance}`);
  }
  return balance;
}

/**
 * Validate a per-account multiplication factor.
 *
 * Distinct from validateBalance for a reason: a balance may legitimately be
 * negative or zero, a factor may not. Reusing the balance validator here meant
 * `factor: 0` (every balance silently becomes 0) and `factor: -1` (every sign
 * flipped) passed validation on the public `updateAccountBalance` path. The Joi
 * config schema already enforces `positive()`, so the gap only affected direct
 * callers — which is exactly the boundary a public method has to defend.
 *
 * @param {*} factor - Factor value to validate
 * @returns {number} Validated factor
 * @throws {Error} If validation fails
 */
function validateFactor(factor) {
  if (typeof factor !== 'number' || !Number.isFinite(factor)) {
    throw new Error(`Invalid factor: must be a finite number, got ${typeof factor}`);
  }
  if (factor <= 0) {
    throw new Error(`Invalid factor: must be greater than zero, got ${factor}`);
  }
  if (factor > constants.MAX_BALANCE_FACTOR) {
    throw new Error(
      `Invalid factor: must not exceed ${constants.MAX_BALANCE_FACTOR}, got ${factor}`
    );
  }
  return factor;
}

/**
 * Validate account name
 * @param {*} name - Account name to validate
 * @returns {string} Validated and sanitized name
 * @throws {Error} If validation fails
 */
function validateAccountName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    AuditLogger.logValidationFailure('account_name', { reason: 'empty_string' });
    throw new Error('Account name must be a non-empty string');
  }

  const trimmed = name.trim();

  if (trimmed.length > constants.MAX_ACCOUNT_NAME_LENGTH) {
    AuditLogger.logValidationFailure('account_name', {
      reason: 'too_long',
      length: trimmed.length,
    });
    throw new Error(`Account name must not exceed ${constants.MAX_ACCOUNT_NAME_LENGTH} characters`);
  }

  // Reject obviously malicious payloads as defense-in-depth. Account names are
  // used only as identifiers and serialized as JSON (never rendered as HTML),
  // so we must NOT HTML-escape them here: escaping would corrupt legitimate
  // names containing characters like & < > " ' and break account matching
  // against the values returned by the Actual Budget and Ghostfolio APIs.
  if (/<script|javascript:|on\w+=/i.test(trimmed)) {
    AuditLogger.logSecurityEvent('xss_attempt', 'high', { input: 'account_name' });
    throw new Error('Account name contains invalid characters');
  }

  return trimmed;
}

/**
 * Validate the Actual Budget data directory.
 *
 * Called once at scheduler startup rather than per sync: a data directory that is
 * missing or unwritable is a deployment fault, and failing at startup with the
 * resolved path in the message beats an opaque SQLite error every night at 05:00.
 * The old entrypoint silently skipped its `[ -d ]` guard when the path did not
 * exist, and Actual then wrote to a location that was not persisted.
 *
 * @param {*} dir - Candidate directory (typically process.env.ACTUAL_BUDGET_DATA_DIR)
 * @returns {string|undefined} Resolved absolute path, or undefined if unset
 * @throws {Error} If the path is unusable
 */
function validateDataDir(dir) {
  if (dir === undefined || dir === null || dir === '') {
    return undefined;
  }

  if (typeof dir !== 'string') {
    throw new Error(`ACTUAL_BUDGET_DATA_DIR must be a string, got ${typeof dir}`);
  }

  if (!path.isAbsolute(dir)) {
    throw new Error(`ACTUAL_BUDGET_DATA_DIR must be an absolute path, got "${dir}"`);
  }

  const resolved = path.resolve(dir);

  if (PROTECTED_DATA_DIRS.has(resolved)) {
    AuditLogger.logValidationFailure('data_dir', { reason: 'protected_path' });
    throw new Error(
      `ACTUAL_BUDGET_DATA_DIR must not be a system directory, got "${resolved}". ` +
        'Point it at a dedicated volume mount such as /actual-budget.'
    );
  }

  let stats;
  try {
    // Inspecting an operator-supplied path is this function's entire purpose, and the
    // path is checked here rather than opened.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(
      `ACTUAL_BUDGET_DATA_DIR "${resolved}" does not exist. ` +
        'Create it, or mount a volume there before starting the container.'
    );
  }

  if (!stats.isDirectory()) {
    throw new Error(`ACTUAL_BUDGET_DATA_DIR "${resolved}" is not a directory`);
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
    throw new Error(
      `ACTUAL_BUDGET_DATA_DIR "${resolved}" is not readable and writable by uid ${uid}. ` +
        'The container runs as uid 1001; chown the volume to 1001:1001.'
    );
  }

  logger.debug('Actual Budget data directory validated', { dataDir: resolved });
  return resolved;
}

/**
 * Environment variables whose values must never reach a log line.
 */
const SECRET_ENV_VARS = ['ACTUAL_BUDGET_PASS', 'GHOSTFOLIO_TOKEN'];

/**
 * Patterns for credential-shaped text, for the cases the exact-value pass cannot
 * catch: a token minted by the remote (the Ghostfolio `authToken` is issued at
 * runtime and is in no environment variable), or a secret embedded in a URL that
 * axios helpfully included in its error message.
 *
 * Each entry keeps its leading label and replaces only the value, so a redacted
 * message still says *what* was suppressed.
 */
const SECRET_PATTERNS = [
  // Authorization: Bearer <token>, and the header as axios renders it
  [/(bearer\s+)[\w\-._~+/]+=*/gi, '$1[REDACTED]'],
  // "accessToken":"…", authToken=…, "password": "…", apiKey: …
  [
    /(["']?(?:access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi,
    '$1[REDACTED]',
  ],
  // https://user:password@host
  [/(:\/\/[^:/?#\s]+:)[^@/?#\s]+@/g, '$1[REDACTED]@'],
];

/**
 * Remove credential-shaped text from a string and bound its length.
 *
 * sanitizeError already withheld stack traces, but it passed `error.message`
 * through verbatim — and a message is not a safe field. axios embeds the request
 * URL and, on some failures, the request configuration; `@actual-app/api` can
 * embed a server response. Anything that lands in an error message lands in
 * logs/combined.log, which is mounted on a volume and read by whoever debugs the
 * container.
 *
 * @param {*} text - Candidate text
 * @param {number} [maxLength] - Maximum length of the result
 * @returns {string} Redacted, length-bounded text
 */
function redactSecrets(text, maxLength = constants.MAX_ERROR_MESSAGE_LENGTH) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  let result = text;

  // Exact known secret values first: a password can be any shape at all, so
  // matching it literally is the only reliable pass. Very short values are
  // skipped — replacing every "a" in a message would destroy it without
  // protecting anything, and such a value fails validateEnvironment anyway.
  const secrets = Object.entries(process.env).filter(([name]) => SECRET_ENV_VARS.includes(name));
  for (const [name, value] of secrets) {
    if (typeof value === 'string' && value.length >= 6) {
      result = result.split(value).join(`[REDACTED:${name}]`);
    }
  }

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  if (result.length > maxLength) {
    result = `${result.slice(0, maxLength)}… [truncated ${result.length - maxLength} chars]`;
  }

  return result;
}

/**
 * Read a message from a thrown or rejected value of unknown shape.
 *
 * Not every rejection carries an Error: libraries reject with plain objects, and
 * the `unhandledRejection` handler can receive null or undefined. Classifying an
 * error with `error.message.includes(...)` on such a value throws a TypeError
 * from inside the catch block, destroying the original failure and the audit
 * event that was about to be written. Always route through this helper.
 *
 * The result is redacted and length-bounded, so every existing call site is safe
 * to log without remembering to sanitize it. Callers use the result for keyword
 * classification too ('authentication', 'network'); those keywords are never
 * redacted, though a message long enough to be truncated could in principle lose
 * one that appears past the cap.
 *
 * @param {*} value - Thrown or rejected value
 * @returns {string} A redacted message string, never undefined
 */
function errorMessageOf(value) {
  if (value instanceof Error) {
    return redactSecrets(value.message);
  }
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (value !== null && typeof value === 'object' && typeof value.message === 'string') {
    return redactSecrets(value.message);
  }
  return `Non-error rejection of type ${value === null ? 'null' : typeof value}`;
}

/**
 * Sanitize error for logging (remove sensitive data)
 * @param {*} error - Error object, or any thrown/rejected value
 * @returns {Object} Sanitized error object safe for logging
 */
function sanitizeError(error) {
  if (error instanceof Error) {
    return {
      message: redactSecrets(error.message),
      code: error.code,
      name: error.name,
      // Explicitly exclude stack trace and other potentially sensitive data.
      // axios attaches `config` (headers, including Authorization) and `request`
      // to its errors; naming the fields we keep means those can never be picked
      // up by a future change here.
    };
  }

  // Non-Error values are described rather than serialized: stringifying an
  // arbitrary object risks both circular references and leaking its contents.
  return {
    message: errorMessageOf(error),
    code: typeof error?.code === 'string' ? error.code : undefined,
    name: error?.constructor?.name || (error === null ? 'null' : typeof error),
  };
}

// There was a generic validateApiResponse(response, requiredFields) here. Both of
// its call sites in ghostfolio.js followed it immediately with a stricter check of
// the same field — `in` is satisfied by a present-but-null `authToken`, and by an
// `accounts` that is a string — so the specific check was doing the work and the
// generic one only decided which of two error messages came out. The checks that
// remain are at their point of use in ghostfolio.js.

module.exports = {
  validateConfig,
  validateEnvironment,
  validateBalance,
  validateFactor,
  validateAccountName,
  validateDataDir,
  errorMessageOf,
  redactSecrets,
  sanitizeError,
};
