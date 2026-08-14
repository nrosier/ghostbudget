const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const logger = require('../logger');
const AuditLogger = require('./audit');
const constants = require('../config/constants');

/**
 * Paths that must never be used as the Actual Budget data directory.
 *
 * The value decides where a SQLite database is created and where the process demands
 * write access, so pointing it at a system directory is never what an operator meant.
 * See docs/decisions.md for the root `chown -R` that first made this urgent.
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
 *
 * `currency` is required, and deliberately so. Nothing in either API tells this
 * tool which currency an Actual Budget balance is denominated in — Actual is
 * single-currency per budget file and does not report it per account, while
 * Ghostfolio is per-account — so without a declared expectation a balance in one
 * currency is written verbatim into an account denominated in another and simply
 * reads as the wrong amount of money. Declaring it turns a silent wrong value into
 * a refused write.
 *
 * `unique('ghostfolioName')` is the other half of the same idea. Two mappings
 * pointing at one Ghostfolio account are not additive: each is a full PUT of the
 * account's balance, so the second overwrites the first and the run still reports
 * success. Uniqueness runs on the trimmed values, so " Savings " and "Savings" are
 * caught as the duplicate they are.
 */
const configSchema = Joi.object({
  accounts: Joi.array()
    .items(
      Joi.object({
        ghostfolioName: Joi.string().trim().min(1).max(255).required(),
        actualBudgetName: Joi.string().trim().min(1).max(255).required(),
        currency: Joi.string()
          .trim()
          .uppercase()
          .pattern(/^[A-Z]{3}$/)
          .required()
          .messages({
            'any.required':
              '"currency" is required: the ISO 4217 code the Actual Budget balance ' +
              'is denominated in, e.g. "EUR". It is checked against the Ghostfolio ' +
              "account's own currency so a mismatch refuses the write.",
          }),
        factor: Joi.number().positive().default(1),
      })
    )
    .min(1)
    .unique('ghostfolioName')
    .required(),
}).required();

/**
 * Schema for validating environment variables
 */
const envSchema = Joi.object({
  // Shape only, and no host allowlist — see docs/decisions.md. Which schemes are
  // acceptable for which hosts is decided by assertTransportSecurity below, which needs
  // the parsed host to say anything useful.
  ACTUAL_BUDGET_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  ACTUAL_BUDGET_PASS: Joi.string().min(constants.MIN_PASSWORD_LENGTH).required(),
  ACTUAL_BUDGET_SYNC_ID: Joi.string().min(1).required(),
  ACTUAL_BUDGET_DATA_DIR: Joi.string().allow('').optional(),
  GHOSTFOLIO_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  GHOSTFOLIO_TOKEN: Joi.string().min(constants.MIN_TOKEN_LENGTH).required(),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),
  // Resolve every mapping, report exactly what would change, send no write. The
  // only thing this tool does to Ghostfolio is overwrite balances, so being able
  // to check a new or edited config.json without doing that is worth one flag.
  DRY_RUN: Joi.boolean().default(false),
  // CACHE_TTL_MINUTES and BATCH_SIZE are gone — see docs/decisions.md. Unknown
  // variables are allowed, so an operator who still has either set in a .env file sees
  // no error; it simply does nothing, as before.
  //
  // Defaulted from the constant rather than a literal, so there is one home for this
  // number rather than one per reader.
  MAX_RETRIES: Joi.number().integer().min(0).max(10).default(constants.MAX_RETRIES),
}).unknown(true); // Allow other env vars

/**
 * One line per distinct problem, naming the mappings that have it.
 *
 * `abortEarly: false` reports every failure, and a schema failure is usually the same
 * failure repeated — six accounts missing `currency` produce six verbatim copies of one
 * 230-character explanation. The count and the paths are what differ between them, so
 * those are what is kept. See docs/decisions.md.
 *
 * @param {Object} error - A Joi ValidationError
 * @returns {string} Deduplicated details, joined with '; '
 */
function summarizeDetails(error) {
  const paths = new Map();

  for (const detail of error.details) {
    const seen = paths.get(detail.message) ?? [];
    seen.push(detail.path.join('.'));
    paths.set(detail.message, seen);
  }

  return [...paths]
    .map(([message, where]) =>
      where.length > 1 ? `${message} [${where.length}: ${where.join(', ')}]` : message
    )
    .join('; ');
}

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
    const details = summarizeDetails(error);
    logger.error('Configuration validation failed', { details });
    throw new Error(`Invalid configuration: ${details}`);
  }

  logger.debug('Configuration validated successfully');
  return value;
}

/**
 * Whether plaintext HTTP to this host keeps the credential off the network.
 *
 * Loopback, an RFC 1918 or IPv6 unique-local address, an mDNS/internal suffix, or
 * a single-label name — which has no public DNS answer, so it can only be a
 * container-network service, a Kubernetes service, or an /etc/hosts entry.
 *
 * @param {string} hostname - Host component of a URL, as `new URL().hostname`
 * @returns {boolean} True if the host is reachable only from a local network
 */
function isPrivateHost(hostname) {
  // new URL() returns an IPv6 literal wrapped in brackets.
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    return (
      a === 127 || // loopback
      a === 10 || // RFC 1918
      (a === 172 && b >= 16 && b <= 31) || // RFC 1918
      (a === 192 && b === 168) || // RFC 1918
      (a === 169 && b === 254) // link-local
    );
  }

  // A name with no dot and no colon is single-label: not a public DNS name.
  return !host.includes('.') && !host.includes(':');
}

/**
 * Refuse to send a credential in plaintext to a host that is not local.
 *
 * Keyed on the host, in every environment, and deliberately not on `NODE_ENV` — that
 * rule was wrong in both directions, see docs/decisions.md. This protects the case that
 * is actually dangerous, credentials crossing a network someone else can see, and permits
 * the case that is not.
 *
 * @param {string} name - Environment variable name, for the error message
 * @param {string} value - URL to check
 * @throws {Error} If the URL is unparseable, or is plaintext to a non-local host
 */
function assertTransportSecurity(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }

  if (url.protocol === 'https:') {
    return;
  }

  if (!isPrivateHost(url.hostname)) {
    AuditLogger.logSecurityEvent('insecure_transport', 'high', { variable: name });
    throw new Error(
      `${name} must use https:// — plaintext HTTP would send the credential across ` +
        'the network. HTTP is accepted only for a loopback or private-network address, ' +
        'or a single-label host such as a Docker Compose service name.'
    );
  }

  // Debug, not warn: this is the recommended deployment, and a warning on every
  // run of a supported configuration only teaches an operator to ignore warnings.
  logger.debug(`${name} uses plaintext HTTP to a private host`, { variable: name });
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
    const details = summarizeDetails(error);
    logger.error('Environment validation failed', { details });
    AuditLogger.logValidationFailure('environment', { details });
    throw new Error(`Invalid environment variables: ${details}`);
  }

  // Checked in every environment, not only production — see assertTransportSecurity.
  assertTransportSecurity('ACTUAL_BUDGET_URL', value.ACTUAL_BUDGET_URL);
  assertTransportSecurity('GHOSTFOLIO_URL', value.GHOSTFOLIO_URL);

  logger.debug('Environment variables validated successfully');
  return value;
}

/**
 * Validate an account balance in minor units.
 *
 * Zero and negative values pass: an emptied account and an overdraft are both real
 * balances, and refusing them here would refuse to sync the truth. What is checked
 * is the magnitude, which no genuine personal balance approaches — see
 * MAX_BALANCE_MINOR_UNITS. Note the error message names no value: these messages
 * are logged and joined into the run summary, and a balance is not something to
 * write to a log file.
 *
 * The all-zero condition is a different question, and not one a single value can
 * answer; it is handled where the whole mapped set is known, in ghostfolio.js.
 *
 * @param {*} balance - Balance value to validate
 * @returns {number} Validated balance
 * @throws {Error} If validation fails
 */
function validateBalance(balance) {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    throw new Error(`Invalid balance: must be a finite number, got ${typeof balance}`);
  }
  if (Math.abs(balance) > constants.MAX_BALANCE_MINOR_UNITS) {
    throw new Error(
      `Invalid balance: magnitude exceeds ${constants.MAX_BALANCE_MINOR_UNITS} minor units, ` +
        'which is a corrupted read rather than a balance'
    );
  }
  return balance;
}

/**
 * Validate a Ghostfolio account id before it is interpolated into a request path.
 *
 * The id comes from Ghostfolio's own response, so this is defence in depth rather
 * than a likely attack — but "the server told us" is not a reason to build a URL
 * out of a value, and a `../` or a query string in this position would address a
 * different endpoint entirely. Ghostfolio ids are generated identifiers, so the
 * allowed character set costs nothing.
 *
 * @param {*} id - Account id from a Ghostfolio response
 * @returns {string} Validated id
 * @throws {Error} If validation fails
 */
function validateAccountId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Ghostfolio account id must be a non-empty string');
  }
  if (id.length > constants.MAX_ACCOUNT_ID_LENGTH) {
    throw new Error(
      `Ghostfolio account id must not exceed ${constants.MAX_ACCOUNT_ID_LENGTH} characters`
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    AuditLogger.logSecurityEvent('unexpected_account_id', 'high', { source: 'ghostfolio' });
    throw new Error('Ghostfolio account id contains unexpected characters');
  }
  return id;
}

/**
 * Validate a per-account multiplication factor.
 *
 * Distinct from validateBalance for a reason: a balance may legitimately be negative or
 * zero, a factor may not — `factor: 0` makes every balance 0 and `factor: -1` flips every
 * sign. See docs/decisions.md.
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
 * missing or unwritable is a deployment fault, and failing at startup with the resolved
 * path in the message beats an opaque SQLite error every night at 05:00.
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

// There is no generic API-response validator here on purpose: a `requiredFields` check
// is satisfied by a present-but-null value, so each response is checked for what it has
// to be at its point of use in ghostfolio.js. See docs/decisions.md.

module.exports = {
  validateConfig,
  validateEnvironment,
  validateBalance,
  validateFactor,
  validateAccountName,
  validateAccountId,
  validateDataDir,
  isPrivateHost,
  errorMessageOf,
  redactSecrets,
  sanitizeError,
};
