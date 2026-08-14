// Load environment variables first
require('dotenv').config({ quiet: true });

const { getAccountBalances } = require('./actualBudget');
const { getClient } = require('./ghostfolio');
const logger = require('./logger');
const build = require('./config/version');
const { getEnv } = require('./config/env');
const AuditLogger = require('./utils/audit');
const { flushLogsAndExit } = require('./utils/exit');
const { errorMessageOf, sanitizeError } = require('./utils/validation');

// Track cleanup state
let isShuttingDown = false;

/**
 * Graceful shutdown handler.
 *
 * There is no cleanup step, deliberately: a sync owns nothing this handler could
 * release more safely than process exit does — see docs/decisions.md. What it has to
 * get right is exiting exactly once, and flushing the log before it does.
 *
 * @param {string} signal - Signal that triggered the shutdown
 */
function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, shutting down`);
  flushLogsAndExit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled rejections. The promise itself is deliberately not logged: it
// serializes to an empty object and carries no diagnostic value.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', sanitizeError(reason));
  flushLogsAndExit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', sanitizeError(error));
  flushLogsAndExit(1);
});

/**
 * A failed connection reports itself as a `code`, not in its message: Node says
 * `connect ECONNREFUSED 127.0.0.1:3333`, axios says `timeout of 30000ms exceeded`, and
 * neither contains the word "network". See docs/decisions.md for what matching on the
 * message cost the audit trail.
 *
 * These codes survive the trip because `authenticate()` and `getAccountBalances()`
 * rethrow what they caught rather than wrapping it.
 */
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
  'ETIMEDOUT',
]);

/**
 * Categorize a failed run for the audit trail.
 *
 * @param {*} error - Whatever the sync rejected with, which need not be an Error
 * @param {string} message - Its message, already read defensively
 * @returns {string} 'network_error', 'auth_error' or 'unknown_error'
 */
function classifyError(error, message) {
  if (NETWORK_ERROR_CODES.has(error?.code)) {
    return 'network_error';
  }

  // Case-insensitive: the messages that describe this are 'Invalid authentication
  // response' and 'Not authenticated', and one of them is capitalized.
  if (/authenticat/i.test(message)) {
    return 'auth_error';
  }

  return 'unknown_error';
}

async function sync() {
  const startTime = Date.now();

  // No `timestamp` on any of the records below: winston's own format.timestamp()
  // already puts one on every record.
  try {
    // The build fields ride on the record this already wrote. Every other record
    // carries the version and commit from the logger's defaultMeta; this is the one
    // that says when the build was made, so it is worth one line per run rather
    // than a field on all of them.
    logger.info('Starting sync process...', build.startup);
    AuditLogger.logSync('started');

    // Explicitly, and here. Every step below needs a valid environment, and the
    // first of them would otherwise be the one to discover it — reporting a missing
    // GHOSTFOLIO_TOKEN as an Actual Budget authentication failure. Inside the try is
    // the part that matters: the handlers registered above are what turn this into a
    // logged, flushed, audited failure instead of a stack trace on stderr.
    getEnv();

    // Get balances from Actual Budget
    logger.info('Fetching balances from Actual Budget...');
    const balances = await getAccountBalances();

    if (!Array.isArray(balances) || balances.length === 0) {
      throw new Error('No balances received from Actual Budget');
    }

    logger.info(`Found ${balances.length} accounts in Actual Budget`);

    // Sync balances to Ghostfolio
    logger.info('Syncing balances to Ghostfolio...');
    const summary = await getClient().syncAccountBalances(balances);

    const duration = Date.now() - startTime;

    // The counts come from the sync, which is the only thing that knows them.
    // `accounts_in_budget` is deliberately not one of them: it is how many accounts
    // Actual Budget has, which is neither how many were mapped nor how many were
    // written. See docs/decisions.md.
    const outcome = {
      duration_ms: duration,
      accounts_in_budget: balances.length,
      ...summary,
    };

    logger.info('Sync completed successfully', outcome);
    AuditLogger.logSync('completed', outcome);

    return true;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Sync failed', { ...sanitizeError(error), duration_ms: duration });

    // Read the message defensively: a non-Error rejection here would otherwise
    // throw a TypeError from inside this catch block and lose the audit event.
    const message = errorMessageOf(error);
    const errorType = classifyError(error, message);

    // `error.summary` is set when the sync ran and some accounts failed, so a
    // partial run records how many balances it did store. Absent for a failure
    // before the write phase (bad config, no auth), where there is nothing to count.
    AuditLogger.logSync('failed', {
      error: message,
      error_type: errorType,
      duration_ms: duration,
      ...(error?.summary ?? {}),
    });

    throw error;
  }
}

// Run sync if this file is run directly
if (require.main === module) {
  sync()
    .then(() => {
      flushLogsAndExit(0);
    })
    .catch((error) => {
      logger.error('Fatal error', sanitizeError(error));
      flushLogsAndExit(1);
    });
}

module.exports = { sync };
