// Load environment variables first
require('dotenv').config();

const { getAccountBalances } = require('./actualBudget');
const ghostfolio = require('./ghostfolio');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const constants = require('./config/constants');
const { errorMessageOf, sanitizeError } = require('./utils/validation');

// Track cleanup state
let isShuttingDown = false;

/**
 * Exit once Winston has flushed, rather than immediately.
 *
 * Winston's File transports write asynchronously, so calling process.exit()
 * directly after logger.error() discards whatever is still buffered — which is
 * exactly the failure reason and the audit event that make the log useful. Wait
 * for the logger to finish, but bound the wait so a stuck transport cannot leave
 * the container hanging.
 *
 * @param {number} code - Process exit code
 */
function flushLogsAndExit(code) {
  // Set immediately so the code is correct even if the process ends another way.
  process.exitCode = code;

  let exited = false;
  const exit = () => {
    if (exited) {
      return;
    }
    exited = true;
    process.exit(code);
  };

  const timer = setTimeout(exit, constants.LOG_FLUSH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  logger.on('finish', exit);
  logger.end();
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // Add any cleanup logic here (close connections, etc.)
    logger.info('Cleanup completed');
    flushLogsAndExit(0);
  } catch (error) {
    logger.error('Error during shutdown', sanitizeError(error));
    flushLogsAndExit(1);
  }
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

  try {
    logger.info('Starting sync process...', { timestamp: new Date().toISOString() });
    AuditLogger.logSync('started', { timestamp: new Date().toISOString() });

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
    logger.info('Sync completed successfully', {
      duration_ms: duration,
      accounts_synced: balances.length,
      timestamp: new Date().toISOString(),
    });

    AuditLogger.logSync('completed', {
      duration_ms: duration,
      accounts_synced: balances.length,
      timestamp: new Date().toISOString(),
    });

    return true;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Sync failed', {
      ...sanitizeError(error),
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    });

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
      timestamp: new Date().toISOString(),
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
