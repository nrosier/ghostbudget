// Load environment variables first
require('dotenv').config({ quiet: true });

const { getAccountBalances } = require('./actualBudget');
const ghostfolio = require('./ghostfolio');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const { flushLogsAndExit } = require('./utils/exit');
const { errorMessageOf, sanitizeError } = require('./utils/validation');

// Track cleanup state
let isShuttingDown = false;

/**
 * Graceful shutdown handler.
 *
 * There is no cleanup step here, and the "add any cleanup logic here" placeholder
 * that used to stand in for one — wrapped in a try/catch around a single log call,
 * so the catch was unreachable — has gone with it. A sync owns nothing that this
 * handler could release more safely than process exit does: the Actual Budget
 * connection is closed by getAccountBalances before it returns, and an interrupted
 * one is inside a native better-sqlite3 call that will not unwind on request.
 *
 * What the handler has to get right is exiting exactly once, and flushing the log
 * before it does — both of which it still does.
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

async function sync() {
  const startTime = Date.now();

  // No `timestamp` on any of the records below: winston's own format.timestamp()
  // already puts one on every record, so passing another only produced two fields
  // that had to agree.
  try {
    logger.info('Starting sync process...');
    AuditLogger.logSync('started');

    // Get balances from Actual Budget
    logger.info('Fetching balances from Actual Budget...');
    const balances = await getAccountBalances();

    if (!balances || !Array.isArray(balances) || balances.length === 0) {
      throw new Error('No balances received from Actual Budget');
    }

    logger.info(`Found ${balances.length} accounts in Actual Budget`);

    // Sync balances to Ghostfolio
    logger.info('Syncing balances to Ghostfolio...');
    await ghostfolio.syncAccountBalances(balances);

    const duration = Date.now() - startTime;
    const outcome = { duration_ms: duration, accounts_synced: balances.length };

    logger.info('Sync completed successfully', outcome);
    AuditLogger.logSync('completed', outcome);

    return true;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Sync failed', { ...sanitizeError(error), duration_ms: duration });

    // Read the message defensively: a non-Error rejection here would otherwise
    // throw a TypeError from inside this catch block and lose the audit event.
    const message = errorMessageOf(error);
    const errorType = message.includes('authentication')
      ? 'auth_error'
      : message.includes('network')
        ? 'network_error'
        : 'unknown_error';

    AuditLogger.logSync('failed', {
      error: message,
      error_type: errorType,
      duration_ms: duration,
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
