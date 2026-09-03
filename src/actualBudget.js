// Pin the TLS floor before any connection is opened. @actual-app/api builds its
// own HTTP client, so this is the only thing that covers this leg of the egress.
require('./config/tls');

const api = require('@actual-app/api');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const constants = require('./config/constants');
const { getEnv } = require('./config/env');
const {
  validateBalance,
  validateAccountName,
  errorMessageOf,
  sanitizeError,
} = require('./utils/validation');

/**
 * Codes a transient connection failure reports itself as.
 *
 * Deliberately an allowlist rather than a list of things not to retry. A wrong password,
 * an unwritable data directory and a malformed sync ID are all permanent: there is
 * nothing to gain by attempting any of them four times, and an audit trail to muddy.
 * Anything not recognised here fails on the first attempt, as it did before.
 */
const TRANSIENT_ERROR_CODES = new Set([
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
 * The same failures as they arrive from @actual-app/api, which does not preserve
 * `error.code` — it builds its own HTTP client and reports a refused connection as text.
 *
 * `Could not get remote files` is its own wording for "the server did not answer", which
 * is also what a wrong sync ID or password looks like. Retrying those costs four attempts
 * inside seven seconds and then reports the identical failure, which is a better trade
 * than declining to retry the case that would have succeeded — a server that is still
 * starting up when the 05:00 sync fires.
 */
const TRANSIENT_MESSAGE =
  /Could not get remote files|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|fetch failed/i;

/**
 * Is this failure worth another attempt?
 *
 * @param {*} error - Whatever was thrown, which need not be an Error
 * @returns {boolean} True if the failure looks transient
 */
function isTransient(error) {
  return TRANSIENT_ERROR_CODES.has(error?.code) || TRANSIENT_MESSAGE.test(errorMessageOf(error));
}

/**
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Close the connection without letting the close become the failure.
 *
 * Called both on the way out of a run and between retry attempts, and in neither case
 * does a connection that will not close cleanly invalidate anything.
 *
 * @returns {Promise<void>}
 */
async function closeQuietly() {
  try {
    await api.shutdown();
    logger.debug('Connection closed successfully');
  } catch (shutdownError) {
    // Never rethrown: on the failure path this would replace the error that actually
    // explains the run, and on the success path a connection that cannot be closed
    // cleanly does not invalidate balances already read.
    logger.warn('Failed to close the Actual Budget connection', sanitizeError(shutdownError));
  }
}

async function getAccountBalances() {
  // Whether init() got far enough that there is something to close. Set before the
  // await returns is not enough — a rejection from init() can still leave a socket
  // or a SQLite handle open — so the flag is raised before the call.
  let opened = false;

  try {
    const env = getEnv();

    // env.MAX_RETRIES is the single home for this number: the Joi schema defaults it
    // from constants.MAX_RETRIES. See docs/decisions.md.
    const attempts = env.MAX_RETRIES + 1;

    // Connect and download retry as one unit, with a full shutdown between attempts.
    // @actual-app/api holds a server session and a local SQLite handle, and calling
    // init() again on top of a half-open one is how a retry turns a transient failure
    // into corrupt local state. A clean close costs milliseconds and removes the
    // question. This is also why the download is inside the loop rather than after it:
    // it is the step that reads the budget over the network, so it fails for the same
    // transient reasons the connect does, and it needs the same fresh session.
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      opened = true;

      try {
        logger.debug('Initializing Actual Budget API...');
        await api.init({
          dataDir: env.ACTUAL_BUDGET_DATA_DIR,
          serverURL: env.ACTUAL_BUDGET_URL.replace(/\/$/, ''),
          password: env.ACTUAL_BUDGET_PASS,
        });

        logger.info('Successfully connected to Actual Budget server');
        // Once per successful init, so a run that connected twice says so. An
        // authentication that happened is a fact the audit trail should carry whether
        // or not the attempt it belonged to went on to succeed.
        AuditLogger.logAuth(true, { service: 'actualbudget' });

        logger.debug('Downloading budget data...');
        await api.downloadBudget(env.ACTUAL_BUDGET_SYNC_ID);
        logger.debug('Budget data downloaded successfully');
        break;
      } catch (error) {
        if (attempt === attempts || !isTransient(error)) {
          throw error;
        }

        await closeQuietly();
        opened = false;

        const waitMs = Math.min(
          constants.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          constants.MAX_RETRY_DELAY_MS
        );
        logger.warn('Actual Budget connection failed, retrying', {
          attempt,
          attempts,
          retry_in_ms: waitMs,
          ...sanitizeError(error),
        });
        await delay(waitMs);
      }
    }

    // Get all accounts
    logger.debug('Fetching accounts...');
    const accounts = await api.getAccounts();

    if (!Array.isArray(accounts)) {
      throw new Error('Invalid response from getAccounts: expected array');
    }

    logger.info(`Found ${accounts.length} accounts`);

    // Every balance read one at a time, validated as it is read, and one account's
    // failure costing only that account. @actual-app/api reads balances out of a local
    // better-sqlite3 database and its calls are synchronous, so a sequential loop costs
    // nothing against the Promise.all this replaced — see docs/decisions.md for the
    // BATCH_SIZE that tried to bound the same thing.
    //
    // The Promise.all was all-or-nothing: one closed account returning a null balance,
    // or one account whose name does not validate, rejected the whole thing and no
    // account in the budget was synced. Skipping that account instead is safe because
    // a skipped account is *absent*, not wrong — see the note below.
    logger.debug('Fetching account balances...');
    const balances = [];
    const skipped = [];

    for (const account of accounts) {
      let name;

      try {
        name = validateAccountName(account?.name);
      } catch (error) {
        // The name itself is not logged here: it is the value that just failed
        // validation, so it is precisely what should not be written to a log file.
        skipped.push(`an account with an unusable name (${errorMessageOf(error)})`);
        logger.warn('Skipping an account whose name is not usable', sanitizeError(error));
        continue;
      }

      try {
        balances.push({
          name,
          balance: validateBalance(await api.getAccountBalance(account.id)),
        });
      } catch (error) {
        // Account names are logged; the balance is not, and none of these messages
        // carries one — validateBalance reports the bound it exceeded, not the value.
        skipped.push(`${name} (${errorMessageOf(error)})`);
        // The same audit primitive validateAccountName already emits for the name case,
        // so both halves of an unreadable account land in the trail the same way.
        AuditLogger.logValidationFailure('account_balance', { account: name });
        logger.warn('Skipping an account whose balance could not be read', {
          account: name,
          ...sanitizeError(error),
        });
      }
    }

    if (skipped.length > 0) {
      // Reported, not thrown. A skipped account is missing from the returned list, so a
      // config.json mapping that names it fails to resolve in syncAccountBalances and
      // the run still exits non-zero carrying that account's own reason — while every
      // other account syncs. Throwing here would instead cost every account its sync,
      // and an unreadable account is the one case where this tool has nothing correct
      // to write. Nothing bogus is written either way. See docs/decisions.md.
      logger.warn(
        `Skipped ${skipped.length} of ${accounts.length} accounts: ${skipped.join('; ')}`
      );
    }

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
      await closeQuietly();
    }
  }
}

module.exports = {
  getAccountBalances,
};
