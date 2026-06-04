// Load environment variables first
require('dotenv').config();

const { getAccountBalances } = require('./actualBudget');
const ghostfolio = require('./ghostfolio');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const { sanitizeError } = require('./utils/validation');
const { trackSyncDuration, recordSyncError, recordAccountsSynced } = require('./utils/metrics');

// Track cleanup state
let isShuttingDown = false;

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
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', sanitizeError(error));
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason: sanitizeError(reason) });
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', sanitizeError(error));
  process.exit(1);
});

async function sync() {
  const startTime = Date.now();

  try {
    logger.info('Starting sync process...', { timestamp: new Date().toISOString() });
    AuditLogger.logSync('started', { timestamp: new Date().toISOString() });

    // Track sync duration with metrics
    const result = await trackSyncDuration(async () => {
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

      // Record successful sync metrics
      recordAccountsSynced(balances.length);

      return balances.length;
    });

    const duration = Date.now() - startTime;
    logger.info('Sync completed successfully', {
      duration_ms: duration,
      accounts_synced: result,
      timestamp: new Date().toISOString(),
    });

    AuditLogger.logSync('completed', {
      duration_ms: duration,
      accounts_synced: result,
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

    // Record error metrics
    const errorType = error.message.includes('authentication')
      ? 'auth_error'
      : error.message.includes('network')
        ? 'network_error'
        : 'unknown_error';
    recordSyncError(errorType);

    AuditLogger.logSync('failed', {
      error: error.message,
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
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Fatal error', sanitizeError(error));
      process.exit(1);
    });
}

module.exports = { sync };
