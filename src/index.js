const { getAccountBalances } = require('./actualBudget');
const ghostfolio = require('./ghostfolio');
const logger = require('./logger');
const { sanitizeError } = require('./utils/validation');

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
  try {
    logger.info('Starting sync process...');

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

    logger.info('Sync completed successfully!');
    return true;
  } catch (error) {
    logger.error('Sync failed', sanitizeError(error));
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
