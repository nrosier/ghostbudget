// Pin the TLS floor before any connection is opened. @actual-app/api builds its
// own HTTP client, so this is the only thing that covers this leg of the egress.
require('./config/tls');

const api = require('@actual-app/api');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const {
  validateEnvironment,
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
    // Validate environment variables
    const env = validateEnvironment(process.env);

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

    // Get balances for all accounts with validation.
    //
    // This used to run in BATCH_SIZE-sized slices, described as preventing memory
    // issues with large account lists. It did neither thing: @actual-app/api reads
    // balances out of a local better-sqlite3 database, whose calls are synchronous,
    // so Promise.all never overlapped any work and the slices never bounded
    // anything — every balance ended up in the same array either way. What was
    // left was a loop, an environment variable, and a log line per batch.
    logger.debug('Fetching account balances...');
    const balances = await Promise.all(
      accounts.map(async (account) => ({
        name: validateAccountName(account.name),
        balance: validateBalance(await api.getAccountBalance(account.id)),
      }))
    );

    // Account names are logged; balance values are not, in any environment.
    // This used to be gated on NODE_ENV !== 'production', which meant every
    // balance was written to logs/combined.log on a developer machine and in any
    // deployment that had not set NODE_ENV — while SECURITY.md stated flatly that
    // logs do not contain balances. The gate is gone rather than the claim: a log
    // file is the wrong place for account values regardless of environment, and it
    // outlives the process on a mounted volume.
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
    // The shutdown call used to be the last statement of the try block, so every
    // path that threw after init() — a failed budget download, a rejected balance,
    // an account name that did not validate — left the server connection and the
    // local SQLite handle open until the process exited. Under the scheduler that
    // process is a fork whose exit is not instant.
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
