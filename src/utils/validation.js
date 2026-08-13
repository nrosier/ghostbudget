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
  CACHE_TTL_MINUTES: Joi.number().integer().min(1).max(60).default(5),
  BATCH_SIZE: Joi.number().integer().min(1).max(50).default(10),
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
 * Read a message from a thrown or rejected value of unknown shape.
 *
 * Not every rejection carries an Error: libraries reject with plain objects, and
 * the `unhandledRejection` handler can receive null or undefined. Classifying an
 * error with `error.message.includes(...)` on such a value throws a TypeError
 * from inside the catch block, destroying the original failure and the audit
 * event that was about to be written. Always route through this helper.
 *
 * @param {*} value - Thrown or rejected value
 * @returns {string} A message string, never undefined
 */
function errorMessageOf(value) {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object' && typeof value.message === 'string') {
    return value.message;
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
      message: error.message,
      code: error.code,
      name: error.name,
      // Explicitly exclude stack trace and other potentially sensitive data
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

/**
 * Validate API response structure
 * @param {*} response - API response to validate
 * @param {Array<string>} requiredFields - Required fields in response
 * @returns {Object} Validated response
 * @throws {Error} If validation fails
 */
function validateApiResponse(response, requiredFields = []) {
  if (!response || typeof response !== 'object') {
    throw new Error('Invalid API response: must be an object');
  }

  for (const field of requiredFields) {
    if (!(field in response)) {
      throw new Error(`Invalid API response: missing required field '${field}'`);
    }
  }

  return response;
}

module.exports = {
  validateConfig,
  validateEnvironment,
  validateBalance,
  validateAccountName,
  validateDataDir,
  errorMessageOf,
  sanitizeError,
  validateApiResponse,
};
