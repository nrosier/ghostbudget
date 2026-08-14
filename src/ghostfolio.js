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
const {
  validateConfig,
  validateEnvironment,
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
 * This was `Array.prototype.find()` on both sides of a mapping, which takes the
 * first match and says nothing about the rest. Neither system enforces unique
 * account names, so two accounts named "Savings" meant the balance went to
 * whichever one the API happened to list first — the other was never touched, the
 * run reported success, and nothing anywhere said the name had been ambiguous. For
 * a mapping that addresses accounts *by name*, more than one match is not something
 * to resolve by picking; it is a configuration that cannot be carried out.
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
 * Rounding happens in minor units, before dividing. Actual Budget stores balances as
 * integer cents, but a factor need not be an integer, and float arithmetic on the way
 * out produced values like 1100.1320000000001 from 100012 * 1.1 / 100 — sent verbatim
 * to a financial API and stored as the account's balance.
 *
 * Shared rather than inlined because two places need the same number: the write, and
 * the read-back that confirms it. Two copies of this expression could drift by a cent
 * and turn every confirmed write into a reported mismatch.
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
 * The account PUT used to hand-build its payload from seven fixed fields, which
 * meant any field the account model gained was sent absent — and on a PUT that is
 * a reset, not a no-op. The obvious fix is to spread the fetched account, but that
 * breaks against the live API: Ghostfolio's NestJS validation pipe runs with
 * `forbidNonWhitelisted: true`, so a single property outside the DTO fails the
 * whole request with a 400. The GET response carries plenty of them — computed
 * values, the expanded platform, tag objects.
 *
 * So the fetched account is projected onto the DTO's own field set instead:
 * nothing is invented, nothing outside the contract is sent, and a field added to
 * the DTO is one entry away from being carried through.
 *
 * `tags` is deliberately excluded. It is in the DTO, but the GET returns tag
 * *objects* while the DTO expects an array of ids, and Ghostfolio's update
 * implements tags as delete-all-then-create — so sending them back would either
 * fail validation or destroy the account's tags. Omitting the property leaves the
 * existing associations untouched.
 *
 * Verified against ghostfolio/ghostfolio@main:
 * libs/common/src/lib/dtos/update-account.dto.ts, apps/api/src/main.ts,
 * apps/api/src/app/account/account.service.ts.
 */
const UPDATABLE_ACCOUNT_FIELDS = ['comment', 'currency', 'id', 'name'];

class GhostfolioAPI {
  constructor() {
    // Validated once, here. The environment cannot change under a running process,
    // and every value this client needs is taken from the result — authenticate()
    // used to re-run the whole schema on each call for the sake of one field.
    const env = validateEnvironment(process.env);
    this.baseURL = env.GHOSTFOLIO_URL.replace(/\/$/, '');
    // Ghostfolio's anonymous-user security token, exchanged for a short-lived
    // authToken by authenticate(). `accessToken` below holds that authToken.
    this.securityToken = env.GHOSTFOLIO_TOKEN;
    this.accessToken = null;
    this.configPath = path.join(__dirname, '..', 'config.json');
    // Resolve and report, write nothing. Read once here rather than from
    // process.env at each write, so a run cannot change mode halfway through.
    this.dryRun = env.DRY_RUN === true;

    // A local, not a field: the only reader is the axiosRetry call below. As
    // `this.maxRetries` it looked like state something outside might consult.
    const maxRetries = env.MAX_RETRIES ?? constants.MAX_RETRIES;

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
        // A sync issues its requests one at a time, so the pool never holds more
        // than one socket and sizing it is meaningless. keepAlive is the part that
        // earns its place: it reuses that socket instead of re-handshaking TLS for
        // every account.
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

    // Retry is the only resilience layer here, and deliberately so.
    //
    // There was a rate limiter and a circuit breaker wrapped around this instance.
    // Neither could do its job in this process, and the breaker did active harm.
    //
    // The limiter allowed 10 requests per second, but a sync issues its requests
    // strictly sequentially — `await` per account in syncAccountBalances — so at
    // most one is ever in flight. One-at-a-time is a tighter bound than 10/s, and
    // the queue in front of it never queued anything.
    //
    // The breaker opened at a 50% error rate over the shared request stream. In a
    // run where authentication and the account fetch succeed and then some account
    // PUTs fail — a couple of stale mappings, say — the third failure opened it,
    // and from that point every remaining account was rejected locally with
    // "Breaker is open". So three bad mappings stopped the accounts behind them
    // from being written at all, and replaced each one's real Ghostfolio error in
    // the summary and the audit trail with the breaker's own message. Its 30 s
    // resetTimeout could not help: a sync is a one-shot process that exits long
    // before it elapses. The wall-clock backstop is the scheduler's
    // SYNC_TIMEOUT_MS, which bounds the whole run and escalates to SIGKILL.
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

    // There is no cache here any more. One was maintained with a configurable TTL
    // and then invalidated after every balance update — in a process that fetches
    // the account list exactly once and exits, so it never served a single read.
    // CACHE_TTL_MINUTES could not have any effect whatever it was set to.
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
   * This used to compare against the balance in the update response, which cannot
   * work: `PUT /api/v1/account/:id` returns a Prisma `Account`, and that model has
   * no `balance` column at all — balances live in `AccountBalance` rows keyed by
   * (accountId, date), which `updateAccount` writes separately under today's date.
   * So the response never carried a balance, the comparison never ran, and every
   * write logged "could not confirm" instead. A check that cannot fire is worse than
   * no check, because the log says something was verified.
   *
   * The account list, by contrast, does carry `balance`: Ghostfolio derives it as
   * the most recent non-future `AccountBalance` value, which after a write today is
   * the value written. One extra GET per run confirms every write in it.
   *
   * No balance appears in any message or log line, here or anywhere else. The
   * operator can read both values in Ghostfolio's own UI; a log file on a mounted
   * volume is not the place for them.
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
   * have been written). This used to return the update response body, which no
   * caller read and which carries nothing worth reading.
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

      // Nothing to do, so nothing is sent. The PUT used to fire regardless — the
      // `changed` flag only decided what the audit trail said about it — which
      // meant a nightly run rewrote every mapped account's balance every night,
      // including the ones that had not moved. Every write is an opportunity to
      // store the wrong number; the cheapest way to not store a wrong number is to
      // not write. On a typical run this skips all of them.
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
      throw new Error(`Config file error: ${errorMessageOf(error)}`);
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
    // declares it and this compares. Without it a balance denominated in one
    // currency was written verbatim into an account denominated in another — no
    // error, no warning, just the wrong amount of money from then on. `factor` is
    // not a substitute: using it as an exchange rate freezes that rate into the
    // config, where it silently goes stale.
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
   * The summary is the point of the return value: the caller cannot derive it. It
   * knows how many accounts Actual Budget has, which is neither the number mapped
   * nor the number written, and the top-level audit record used to report that
   * count as `accounts_synced` — 20 for a budget with 20 accounts and two mappings.
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
    // Config first. It used to be read after authenticating, so a mistyped
    // config.json still exchanged the security token for an auth token and fetched
    // the account list before failing on something local to this machine.
    const config = this.readAccountMappings();

    await this.authenticate();
    const ghostfolioAccounts = await this.getGhostfolioAccounts();

    const errors = [];

    // Phase one: work out every intended write. Nothing is sent in this loop.
    //
    // Resolution used to be interleaved with writing, one mapping at a time, which
    // meant the first accounts were already written before the later ones had been
    // looked at — so a check that depends on the whole set could not exist. Both
    // phases still record per-mapping failures and carry on, so one bad mapping
    // does not cost the others their sync.
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
    // A zero is a valid balance — an emptied account really does hold nothing — so
    // no single value can be rejected on its own. Every mapped account reading zero
    // at once is a different claim, and not one a real set of accounts makes. It is
    // what a budget that downloaded but did not apply its sync messages looks like,
    // or a wrong ACTUAL_BUDGET_SYNC_ID pointing at an empty budget. None of those
    // throw, so every guard upstream passes and the run would overwrite real
    // balances with zeros and report success. Refusing here, before phase two,
    // means not one account is touched.
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

module.exports = new GhostfolioAPI();
