// Pin the TLS floor process-wide before any client is constructed.
require('./config/tls');

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const constants = require('./config/constants');
const { getEnv } = require('./config/env');
const {
  validateConfig,
  validateBalance,
  validateFactor,
  validateAccountName,
  validateAccountId,
  errorMessageOf,
  sanitizeError,
} = require('./utils/validation');

/**
 * The single account with this name, or an error saying why there isn't one.
 *
 * Neither system enforces unique account names, and a mapping that addresses accounts
 * *by name* cannot resolve two matches by picking one. More than one match is a
 * configuration that cannot be carried out. See docs/decisions.md.
 *
 * @param {Array} accounts - Accounts to search
 * @param {string} name - Exact account name to match
 * @param {string} side - Which system, for the error message
 * @returns {Object} The single matching account
 * @throws {Error} If no account matches, or more than one does
 */
function exactlyOneNamed(accounts, name, side) {
  const matches = accounts.filter((account) => account?.name === name);

  if (matches.length === 0) {
    throw new Error(`No matching ${side} account found for ${name}`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous mapping: ${matches.length} ${side} accounts are named ${name}. ` +
        'Rename one of them so the mapping addresses exactly one account.'
    );
  }

  return matches[0];
}

/**
 * Convert an Actual Budget balance to the value Ghostfolio stores.
 *
 * Rounding happens in minor units, before dividing: a non-integer factor applied to
 * float major units produces values like 1100.1320000000001, which is not a balance.
 *
 * Shared rather than inlined because the write and the read-back that confirms it need
 * the same number, to the cent. See docs/decisions.md.
 *
 * @param {number} balanceInMinorUnits - Validated Actual Budget balance
 * @param {number} factor - Validated positive multiplier
 * @returns {number} Balance in major units, as Ghostfolio stores it
 */
function toStoredBalance(balanceInMinorUnits, factor) {
  return Math.round(balanceInMinorUnits * factor) / 100;
}

/**
 * The fields Ghostfolio's `UpdateAccountDto` accepts, besides `balance`.
 *
 * The fetched account is projected onto this set rather than spread: Ghostfolio's
 * validation pipe runs with `forbidNonWhitelisted: true`, so one property outside the
 * DTO fails the whole request with a 400, and the GET carries plenty of them. Nothing
 * is invented, nothing outside the contract is sent, and a field added to the DTO is
 * one entry away from being carried through.
 *
 * `tags` is deliberately excluded: the GET returns tag *objects* while the DTO expects
 * ids, and the update implements tags as delete-all-then-create, so sending them back
 * would either fail validation or destroy the account's tags. Omitting the property
 * leaves the existing associations untouched.
 *
 * Verified against ghostfolio/ghostfolio@main:
 * libs/common/src/lib/dtos/update-account.dto.ts, apps/api/src/main.ts,
 * apps/api/src/app/account/account.service.ts. See docs/decisions.md.
 */
const UPDATABLE_ACCOUNT_FIELDS = ['comment', 'currency', 'id', 'name'];

class GhostfolioAPI {
  constructor() {
    // Every value this client needs comes from the one validated environment. See
    // config/env.js for why the validation is no longer inline here.
    const env = getEnv();
    this.baseURL = env.GHOSTFOLIO_URL.replace(/\/$/, '');
    // Ghostfolio's anonymous-user security token, exchanged for a short-lived
    // authToken by authenticate(). `accessToken` below holds that authToken.
    this.securityToken = env.GHOSTFOLIO_TOKEN;
    this.accessToken = null;
    this.configPath = path.join(__dirname, '..', 'config.json');
    // Resolve and report, write nothing. Read once here rather than from
    // process.env at each write, so a run cannot change mode halfway through.
    this.dryRun = env.DRY_RUN === true;

    // A local, not a field: the only reader is the axiosRetry call below. The schema
    // defaults this from constants.MAX_RETRIES, so there is no fallback to apply here.
    const maxRetries = env.MAX_RETRIES;

    // Create secure axios instance with enhanced TLS
    this.axiosInstance = axios.create({
      timeout: constants.HTTP_TIMEOUT_MS,
      maxContentLength: constants.MAX_CONTENT_LENGTH_BYTES,
      maxBodyLength: constants.MAX_BODY_LENGTH_BYTES,
      httpsAgent: new https.Agent({
        rejectUnauthorized: true,
        // Version floor only — see the TLS note in config/constants.js for why the
        // cipher allowlist was removed rather than extended.
        minVersion: constants.TLS_MIN_VERSION,
        maxVersion: constants.TLS_MAX_VERSION,
        // Reuses the one socket a sequential sync needs instead of re-handshaking TLS
        // for every account. The pool is deliberately not sized — see
        // docs/decisions.md.
        keepAlive: true,
      }),
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Add retry logic with exponential backoff, clamped so that the total time of a
    // retry chain stays bounded (exponentialDelay honours an unbounded Retry-After).
    axiosRetry(this.axiosInstance, {
      retries: maxRetries,
      retryDelay: (retryCount, error) =>
        Math.min(axiosRetry.exponentialDelay(retryCount, error), constants.MAX_RETRY_DELAY_MS),
      retryCondition: (error) => {
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 429
        );
      },
      onRetry: (retryCount, error) => {
        logger.warn('Retrying API request', {
          retryCount,
          error: sanitizeError(error),
        });
      },
    });

    // Retry is the only resilience layer here, deliberately: a rate limiter and a
    // circuit breaker were both removed, the breaker because it stopped accounts
    // behind a few bad mappings from being written at all. See docs/decisions.md. The
    // wall-clock backstop is the scheduler's SYNC_TIMEOUT_MS, which bounds the whole
    // run and escalates to SIGKILL.
  }

  async authenticate() {
    try {
      logger.debug('Authenticating with Ghostfolio...');

      const res = await this.axiosInstance({
        method: 'POST',
        url: `${this.baseURL}/api/v1/auth/anonymous`,
        data: {
          accessToken: this.securityToken,
        },
      });

      // Read through optional chaining: a null or non-object body would otherwise
      // throw a TypeError from here and mask what the server actually returned.
      const authToken = res.data?.authToken;

      if (typeof authToken !== 'string' || authToken.length === 0) {
        AuditLogger.logAuth(false, { service: 'ghostfolio', reason: 'invalid_token' });
        throw new Error('Invalid authentication response: missing or empty authToken');
      }

      this.accessToken = authToken;
      logger.info('Successfully authenticated with Ghostfolio');
      AuditLogger.logAuth(true, { service: 'ghostfolio' });
    } catch (error) {
      logger.error('Failed to authenticate with Ghostfolio', sanitizeError(error));
      AuditLogger.logAuth(false, { service: 'ghostfolio', error: errorMessageOf(error) });
      throw error;
    }
  }

  async getGhostfolioAccounts() {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first');
    }

    // No cache: this process fetches the account list once and exits. See
    // docs/decisions.md for the one that used to be here.
    try {
      logger.debug('Fetching Ghostfolio accounts...');

      const response = await this.axiosInstance({
        method: 'GET',
        url: `${this.baseURL}/api/v1/account`,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      // Optional chaining for the same reason as in authenticate(): this one check
      // rejects a null body, a non-object body, a missing `accounts` and an
      // `accounts` that is not an array.
      const accounts = response.data?.accounts;

      if (!Array.isArray(accounts)) {
        throw new Error('Invalid API response: accounts must be an array');
      }

      logger.info(`Found ${accounts.length} Ghostfolio accounts`);
      return accounts;
    } catch (error) {
      logger.error('Failed to fetch Ghostfolio accounts', sanitizeError(error));
      throw error;
    }
  }

  /**
   * Confirm that Ghostfolio stored the balance that was sent, by reading it back.
   *
   * A 2xx is not the claim this tool needs to make. The claim is "the balance in
   * Ghostfolio is the balance from Actual Budget", and the only way to establish it
   * is to ask Ghostfolio what it now holds.
   *
   * The account list is what carries `balance` — Ghostfolio derives it as the most
   * recent non-future `AccountBalance` value, which after a write today is the value
   * written. The update response does not carry one at all, which is why this reads the
   * list back rather than checking what the PUT returned; see docs/decisions.md.
   *
   * No balance appears in any message or log line, here or anywhere else.
   *
   * @param {Array<{ghostfolioAccount: Object, sentBalance: number}>} writes - Completed writes
   * @returns {Promise<{confirmed: number, errors: Array<string>}>} Confirmation outcome
   */
  async confirmStoredBalances(writes) {
    let storedAccounts;

    try {
      storedAccounts = await this.getGhostfolioAccounts();
    } catch (error) {
      // The writes were acknowledged; it is the confirmation that could not be made.
      // Failing the run here would report a failure for a sync that most likely
      // worked, so this is reported as unconfirmed instead — visible as
      // `confirmed < written` in the summary rather than buried in a log line.
      logger.warn(
        'Could not read balances back to confirm them; the writes were acknowledged but ' +
          'are unconfirmed',
        sanitizeError(error)
      );
      return { confirmed: 0, errors: [] };
    }

    const errors = [];
    let confirmed = 0;

    for (const { ghostfolioAccount, sentBalance } of writes) {
      const stored = storedAccounts.find((account) => account.id === ghostfolioAccount.id);
      const storedBalance = Number(stored?.balance);

      if (!stored || !Number.isFinite(storedBalance)) {
        logger.warn(
          `Could not confirm the stored balance for account ${ghostfolioAccount.name}: ` +
            'it is absent from the account list read back',
          { account: ghostfolioAccount.name }
        );
        continue;
      }

      if (Math.abs(storedBalance - sentBalance) >= constants.BALANCE_EPSILON) {
        errors.push(
          `Ghostfolio stored a different balance than was sent for account ` +
            `${ghostfolioAccount.name}`
        );
        continue;
      }

      confirmed += 1;
    }

    return { confirmed, errors };
  }

  /**
   * Bring one Ghostfolio account's balance in line with Actual Budget's.
   *
   * Returns which of the three things happened, because the caller has to be able
   * to report it and cannot work it out for itself: `'written'` (the request was
   * accepted), `'unchanged'` (already correct, nothing sent) or `'dry_run'` (would
   * have been written).
   *
   * `'written'` means accepted, not confirmed — confirming is confirmStoredBalances'
   * job, once the writes are done.
   *
   * @param {Object} ghostfolioAccount - Account as Ghostfolio returned it
   * @param {number} actualBudgetBalance - Balance in minor units
   * @param {number} [factor] - Positive multiplier
   * @returns {Promise<'written'|'unchanged'|'dry_run'>} What happened
   * @throws {Error} If validation fails or the request fails
   */
  async updateAccountBalance(ghostfolioAccount, actualBudgetBalance, factor = 1) {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first');
    }

    try {
      // Validate inputs. The trimmed name is used for messages and audit records
      // only — the payload carries the name exactly as Ghostfolio returned it,
      // because a PUT that sends a different name renames the account.
      const accountName = validateAccountName(ghostfolioAccount.name);
      const accountId = validateAccountId(ghostfolioAccount.id);
      const validatedBalance = validateBalance(actualBudgetBalance);
      const validatedFactor = validateFactor(factor);

      const newBalance = toStoredBalance(validatedBalance, validatedFactor);

      // The previous balance decides whether this write happens at all. It is
      // compared, never logged. A previous balance that is absent or unreadable
      // counts as a change: unknown state is resolved by writing, not by skipping.
      const previousBalance = Number(ghostfolioAccount.balance);
      const changed =
        !Number.isFinite(previousBalance) ||
        Math.abs(previousBalance - newBalance) >= constants.BALANCE_EPSILON;

      // Nothing to do, so nothing is sent. Every write is an opportunity to store the
      // wrong number, and on a typical run this skips all of them. See
      // docs/decisions.md.
      if (!changed) {
        logger.info(`Balance for account ${accountName} is already correct; no write sent`);
        AuditLogger.logBalanceUpdate(accountName, false, {
          service: 'ghostfolio',
          written: false,
        });
        return 'unchanged';
      }

      if (this.dryRun) {
        logger.info(`DRY_RUN: would update the balance of account ${accountName}`);
        AuditLogger.logBalanceUpdate(accountName, true, {
          service: 'ghostfolio',
          written: false,
          dry_run: true,
        });
        return 'dry_run';
      }

      logger.debug('Updating account balance', {
        account: accountName,
        // Balance values are deliberately absent
      });

      const updateData = {
        ...Object.fromEntries(
          Object.entries(ghostfolioAccount).filter(([field]) =>
            UPDATABLE_ACCOUNT_FIELDS.includes(field)
          )
        ),
        balance: newBalance,
        // `platformId` is the one field the DTO requires to be *present* while
        // allowing null, so an account with no platform still has to send it.
        platformId: ghostfolioAccount.platformId ?? null,
      };

      await this.axiosInstance({
        method: 'PUT',
        // encodeURIComponent on top of validateAccountId: the validator already
        // restricts the character set, and encoding costs nothing for an id that
        // passed it. Neither is load-bearing alone.
        url: `${this.baseURL}/api/v1/account/${encodeURIComponent(accountId)}`,
        data: updateData,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      // Nothing in the response is read. It carries a Prisma `Account`, which has no
      // balance column; the balance is confirmed by reading the account list back
      // once the writes are done. See confirmStoredBalances.
      logger.info(`Successfully updated balance for account ${accountName}`);
      AuditLogger.logBalanceUpdate(accountName, true, {
        service: 'ghostfolio',
        written: true,
      });

      return 'written';
    } catch (error) {
      logger.error(
        `Failed to update balance for account ${ghostfolioAccount.name}`,
        sanitizeError(error)
      );
      throw error;
    }
  }

  /**
   * Read and validate the account mappings.
   *
   * @returns {Object} Validated config
   * @throws {Error} If the file cannot be read, parsed or validated
   */
  readAccountMappings() {
    logger.debug('Reading account mappings from config...');

    let configData;
    try {
      // configPath is set in the constructor from __dirname; it is not derived from input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const configContent = fs.readFileSync(this.configPath, 'utf8');
      configData = JSON.parse(configContent);
    } catch (error) {
      logger.error('Failed to read or parse config file', sanitizeError(error));
      // `cause` keeps the original for a caller that wants it. It cannot widen what
      // gets logged: sanitizeError names the three fields it copies out.
      throw new Error(`Config file error: ${errorMessageOf(error)}`, { cause: error });
    }

    return validateConfig(configData);
  }

  /**
   * Turn one mapping into the write it describes, or explain why it cannot be one.
   *
   * Every check that can be made without contacting Ghostfolio is made here, and
   * this method sends nothing. That separation is the point: it lets the caller
   * inspect the whole set of intended writes before the first one happens.
   *
   * @param {Object} mapping - One validated entry from config.accounts
   * @param {Array} actualBalances - Balances from Actual Budget
   * @param {Array} ghostfolioAccounts - Accounts from Ghostfolio
   * @returns {{ghostfolioAccount: Object, balance: number, factor: number}} Intended write
   * @throws {Error} If the mapping cannot be carried out
   */
  resolveMapping(mapping, actualBalances, ghostfolioAccounts) {
    const actualAccountName = validateAccountName(mapping.actualBudgetName);
    const ghostfolioAccountName = validateAccountName(mapping.ghostfolioName);

    const actualAccount = exactlyOneNamed(actualBalances, actualAccountName, 'Actual Budget');
    const ghostfolioAccount = exactlyOneNamed(
      ghostfolioAccounts,
      ghostfolioAccountName,
      'Ghostfolio'
    );

    // Neither API states the currency of an Actual Budget balance, so the config
    // declares it and this compares. `factor` is not a substitute — see
    // docs/decisions.md.
    const accountCurrency = String(ghostfolioAccount.currency ?? '')
      .trim()
      .toUpperCase();

    if (accountCurrency !== mapping.currency) {
      throw new Error(
        `Currency mismatch for account ${ghostfolioAccountName}: config.json declares ` +
          `${mapping.currency}, the Ghostfolio account is denominated in ` +
          `${accountCurrency || '(unset)'}`
      );
    }

    return {
      ghostfolioAccount,
      // Validated here as well as in updateAccountBalance, so the zero-balance gate
      // below is deciding over values already known to be sane numbers.
      balance: validateBalance(actualAccount.balance),
      // The Joi config schema already applies `positive()` with a default of 1;
      // validateFactor is the same rule enforced at the point of use, so the
      // guarantee does not depend on which path the value arrived by.
      factor: validateFactor(mapping.factor),
    };
  }

  /**
   * Sync every mapped account's balance, and report what happened.
   *
   * The summary is the point of the return value: the caller cannot derive it. It knows
   * how many accounts Actual Budget has, which is neither the number mapped nor the
   * number written — see docs/decisions.md for what that once audited.
   *
   * `changed + unchanged === resolved`, and `written === changed` unless this is a
   * dry run, where it is 0. `confirmed` is how many of those writes were read back
   * and matched; it is below `written` only when the read-back could not be made. On
   * failure the same object is attached to the thrown error as `.summary`, so a
   * partial run can still record what it managed to write.
   *
   * @param {Array<{name: string, balance: number}>} actualBalances - Actual Budget accounts
   * @returns {Promise<{mapped: number, resolved: number, changed: number, written: number,
   *   confirmed: number, unchanged: number, failed: number, dry_run: boolean}>} What the run did
   * @throws {Error} If any mapping failed, or if the all-zero gate refused the run
   */
  async syncAccountBalances(actualBalances) {
    // Config first, so a mistyped config.json fails before the security token is
    // exchanged for an auth token and the account list is fetched.
    const config = this.readAccountMappings();

    await this.authenticate();
    const ghostfolioAccounts = await this.getGhostfolioAccounts();

    const errors = [];

    // Phase one: work out every intended write. Nothing is sent in this loop, which is
    // what lets the gate below see the whole set. Both phases record per-mapping
    // failures and carry on, so one bad mapping does not cost the others their sync.
    const targets = [];
    for (const mapping of config.accounts) {
      try {
        targets.push(this.resolveMapping(mapping, actualBalances, ghostfolioAccounts));
      } catch (error) {
        logger.error('Account mapping could not be resolved', sanitizeError(error));
        // Redacted and non-Error-safe: these messages are joined into the thrown
        // summary below, which is itself logged and audited.
        errors.push(errorMessageOf(error));
      }
    }

    // The gate, and the reason there are two phases.
    //
    // A zero is a valid balance, so no single value can be rejected on its own. Every
    // mapped account reading zero at once is a different claim, and one that nothing
    // upstream throws on: it is what a failed or empty Actual Budget download looks
    // like. Refusing here, before phase two, means not one account is touched. See
    // docs/decisions.md.
    if (targets.length > 0 && targets.every((target) => target.balance === 0)) {
      throw new Error(
        `Refusing to sync: all ${targets.length} resolved account(s) report a zero balance, ` +
          'which is what a failed or empty Actual Budget download looks like rather than a ' +
          'set of real balances. Nothing was written. Check ACTUAL_BUDGET_SYNC_ID and that ' +
          'the budget has finished syncing.'
      );
    }

    // Phase two: write. Counted per outcome rather than by length, because the
    // three of them are different claims and only one is "a balance was stored".
    const writes = [];
    let unchanged = 0;
    let wouldWrite = 0;
    for (const target of targets) {
      try {
        const outcome = await this.updateAccountBalance(
          target.ghostfolioAccount,
          target.balance,
          target.factor
        );
        if (outcome === 'written') {
          writes.push({
            ghostfolioAccount: target.ghostfolioAccount,
            sentBalance: toStoredBalance(target.balance, target.factor),
          });
        } else if (outcome === 'unchanged') {
          unchanged += 1;
        } else {
          wouldWrite += 1;
        }
      } catch (error) {
        logger.error('Account sync failed', sanitizeError(error));
        errors.push(errorMessageOf(error));
      }
    }

    // Phase three: read the balances back. A 2xx says the request was accepted, not
    // that the value now in Ghostfolio is the value from Actual Budget — and that
    // second claim is the only one this tool exists to make. One GET confirms every
    // write in the run.
    const written = writes.length;
    let confirmed = 0;
    if (written > 0) {
      const confirmation = await this.confirmStoredBalances(writes);
      confirmed = confirmation.confirmed;
      errors.push(...confirmation.errors);
      for (const message of confirmation.errors) {
        logger.error('Stored balance did not match what was sent', { error: message });
      }
    }

    const summary = {
      mapped: config.accounts.length,
      resolved: targets.length,
      changed: written + wouldWrite,
      written,
      // Reported alongside `written` rather than folded into it: `confirmed < written`
      // means the writes were acknowledged but could not be read back, which is a
      // weaker claim than a confirmed sync and should not look like one.
      confirmed,
      unchanged,
      failed: errors.length,
      dry_run: this.dryRun,
    };

    if (errors.length > 0) {
      // Attached rather than only thrown: the run still wrote whatever it could,
      // and "3 of 5 stored" is the fact an operator needs from a failed sync. The
      // throw stays, so the exit code still reports failure.
      const error = new Error(`Failed to sync ${errors.length} account(s): ${errors.join('; ')}`);
      error.summary = summary;
      throw error;
    }

    logger.info(
      this.dryRun
        ? 'DRY_RUN: every account mapping resolved and no balance was written'
        : 'Successfully synced all account balances',
      summary
    );

    return summary;
  }
}

let client = null;

/**
 * This process's Ghostfolio client, constructed on first use.
 *
 * On demand rather than at require time, because the constructor validates the
 * environment: constructing it here puts that failure inside sync()'s try, where it is
 * logged, audited and flushed like every other one. See config/env.js.
 *
 * @returns {GhostfolioAPI} The client
 */
function getClient() {
  client ??= new GhostfolioAPI();
  return client;
}

module.exports = { GhostfolioAPI, getClient };
