const api = require('@actual-app/api');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const constants = require('./config/constants');
const {
  validateEnvironment,
  validateBalance,
  validateAccountName,
  sanitizeError,
} = require('./utils/validation');

async function getAccountBalances() {
  try {
    // Validate environment variables
    const env = validateEnvironment(process.env);

    logger.debug('Initializing Actual Budget API...');

    // Initialize the Actual API client
    await api.init({
      dataDir: env.ACTUAL_BUDGET_DATA_DIR,
      serverURL: env.ACTUAL_BUDGET_URL.replace(/\/$/, ''),
      password: env.ACTUAL_BUDGET_PASS,
    });

    logger.info('Successfully connected to Actual Budget server');
    AuditLogger.logAuth(true, { service: 'actualbudget' });

    logger.debug('Downloading budget data...');
    await api.downloadBudget(env.ACTUAL_BUDGET_SYNC_ID);
    logger.debug('Budget data downloaded successfully');

    // Get all accounts
    logger.debug('Fetching accounts...');
    const accounts = await api.getAccounts();

    if (!Array.isArray(accounts)) {
      throw new Error('Invalid response from getAccounts: expected array');
    }

    logger.info(`Found ${accounts.length} accounts`);

    // Get balances for all accounts with validation
    // Process in batches to prevent memory issues with large account lists
    logger.debug('Fetching account balances...');
    const balances = [];
    const batchSize = env.BATCH_SIZE || constants.BATCH_SIZE;

    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize);
      logger.debug(
        `Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(accounts.length / batchSize)}`
      );

      const batchBalances = await Promise.all(
        batch.map(async (account) => {
          const accountName = validateAccountName(account.name);
          const balance = await api.getAccountBalance(account.id);
          const validatedBalance = validateBalance(balance);

          return {
            name: accountName,
            balance: validatedBalance,
          };
        })
      );

      balances.push(...batchBalances);
    }

    // Log the results (without sensitive balance details in production)
    if (env.NODE_ENV !== 'production') {
      logger.info('Account Balances:', {
        balances: balances.map((account) => ({
          name: account.name,
          balance: `$${account.balance.toFixed(2)}`,
        })),
      });
    } else {
      logger.info(`Successfully fetched balances for ${balances.length} accounts`);
    }

    // Close the connection
    await api.shutdown();
    logger.debug('Connection closed successfully');
    return balances;
  } catch (error) {
    // Log sanitized error (no stack traces or sensitive data)
    logger.error('Error fetching account balances', sanitizeError(error));
    AuditLogger.logAuth(false, {
      service: 'actualbudget',
      error: error.message,
    });

    if (error.message.includes('Could not get remote files')) {
      logger.error('Connection failed. Verify server URL, sync ID, and credentials are correct');
    }

    // Re-throw to allow caller to handle
    throw error;
  }
}

module.exports = {
  getAccountBalances,
};
