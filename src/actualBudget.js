// Pin the TLS floor before any connection is opened. @actual-app/api builds its
// own HTTP client, so this is the only thing that covers this leg of the egress.
require('./config/tls');

const api = require('@actual-app/api');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const { getEnv } = require('./config/env');
const {
  validateBalance,
  validateAccountName,
  errorMessageOf,
  sanitizeError,
} = require('./utils/validation');

async function getAccountBalances() {
  // Whether init() got far enough that there is something to close. Set before the
  // await returns is not enough — a rejection from init() can still leave a socket
  // or a SQLite handle open — so the flag is raised before the call.
  let opened = false;

  try {
    const env = getEnv();

    logger.debug('Initializing Actual Budget API...');

    // Initialize the Actual API client
    opened = true;
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

    // Every balance in one pass, validated as it is read. @actual-app/api reads them
    // out of a local better-sqlite3 database and its calls are synchronous, so batching
    // this bounds nothing — see docs/decisions.md for the BATCH_SIZE that tried.
    logger.debug('Fetching account balances...');
    const balances = await Promise.all(
      accounts.map(async (account) => ({
        name: validateAccountName(account.name),
        balance: validateBalance(await api.getAccountBalance(account.id)),
      }))
    );

    // Account names are logged; balance values are not, in any environment. A log file
    // outlives the process on a mounted volume, so there is no NODE_ENV under which it
    // is the right place for them — see docs/decisions.md for the gate there used to be.
    logger.info(`Successfully fetched balances for ${balances.length} accounts`);
    logger.debug('Fetched accounts', { accounts: balances.map((account) => account.name) });

    return balances;
  } catch (error) {
    // Log sanitized error (no stack traces or sensitive data)
    logger.error('Error fetching account balances', sanitizeError(error));

    // Read the message defensively — a non-Error rejection would otherwise throw
    // a TypeError from inside this catch block and mask the real failure.
    const message = errorMessageOf(error);
    AuditLogger.logAuth(false, {
      service: 'actualbudget',
      error: message,
    });

    if (message.includes('Could not get remote files')) {
      logger.error('Connection failed. Verify server URL, sync ID, and credentials are correct');
    }

    // Re-throw to allow caller to handle
    throw error;
  } finally {
    // In `finally`, so no path that throws after init() leaves the server connection
    // and the local SQLite handle open — under the scheduler this process is a fork
    // whose exit is not instant. See docs/decisions.md.
    if (opened) {
      try {
        await api.shutdown();
        logger.debug('Connection closed successfully');
      } catch (shutdownError) {
        // Never rethrown: on the failure path this would replace the error that
        // actually explains the run, and on the success path a connection that
        // cannot be closed cleanly does not invalidate balances already read.
        logger.warn('Failed to close the Actual Budget connection', sanitizeError(shutdownError));
      }
    }
  }
}

module.exports = {
  getAccountBalances,
};
