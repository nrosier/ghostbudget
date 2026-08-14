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
  errorMessageOf,
  sanitizeError,
} = require('./utils/validation');

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

  async updateAccountBalance(ghostfolioAccount, actualBudgetBalance, factor = 1) {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first');
    }

    try {
      // Validate inputs
      validateAccountName(ghostfolioAccount.name);
      const validatedBalance = validateBalance(actualBudgetBalance);
      const validatedFactor = validateFactor(factor);

      // Round in minor units before dividing. Actual Budget stores balances as
      // integer cents, but a factor need not be an integer, and float arithmetic
      // on the way out produced values like 1100.1320000000001 from
      // 100012 * 1.1 / 100 — sent verbatim to a financial API and stored as the
      // account's balance.
      const newBalance = Math.round(validatedBalance * validatedFactor) / 100;

      // The previous balance is only used to decide whether this write changes
      // anything. It is compared, never logged.
      const previousBalance = Number(ghostfolioAccount.balance);
      const changed = !Number.isFinite(previousBalance) || previousBalance !== newBalance;

      logger.debug('Updating account balance', {
        account: ghostfolioAccount.name,
        changed,
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

      const response = await this.axiosInstance({
        method: 'PUT',
        url: `${this.baseURL}/api/v1/account/${ghostfolioAccount.id}`,
        data: updateData,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      logger.info(`Successfully updated balance for account ${ghostfolioAccount.name}`);
      // `changed` is computed, not hardcoded. It used to be passed as a literal
      // `true`, so the audit trail recorded a balance change for every account on
      // every run and could not distinguish a real movement from a no-op write.
      AuditLogger.logBalanceUpdate(ghostfolioAccount.name, changed, {
        service: 'ghostfolio',
      });

      return response.data;
    } catch (error) {
      logger.error(
        `Failed to update balance for account ${ghostfolioAccount.name}`,
        sanitizeError(error)
      );
      throw error;
    }
  }

  async syncAccountBalances(actualBalances) {
    await this.authenticate();
    const ghostfolioAccounts = await this.getGhostfolioAccounts();

    logger.debug('Reading account mappings from config...');

    // Read and validate config
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

    const config = validateConfig(configData);
    const errors = [];

    for (const mapping of config.accounts) {
      try {
        // Validate mapping fields
        const actualAccountName = validateAccountName(mapping.actualBudgetName);
        const ghostfolioAccountName = validateAccountName(mapping.ghostfolioName);

        const actualAccount = actualBalances.find((acc) => acc.name === actualAccountName);
        const ghostfolioAccount = ghostfolioAccounts.find(
          (acc) => acc.name === ghostfolioAccountName
        );

        if (!actualAccount) {
          throw new Error(`No matching Actual Budget account found for ${actualAccountName}`);
        }

        if (!ghostfolioAccount) {
          throw new Error(`No matching Ghostfolio account found for ${ghostfolioAccountName}`);
        }

        // The Joi config schema already applies `positive()` with a default of 1;
        // validateFactor is the same rule enforced at the point of use, so the
        // guarantee does not depend on which path the value arrived by.
        const factor = validateFactor(mapping.factor);

        await this.updateAccountBalance(ghostfolioAccount, actualAccount.balance, factor);
      } catch (error) {
        logger.error('Account sync failed', sanitizeError(error));
        // Redacted and non-Error-safe: these messages are joined into the thrown
        // summary below, which is itself logged and audited.
        errors.push(errorMessageOf(error));
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to sync ${errors.length} account(s): ${errors.join('; ')}`);
    }

    logger.info('Successfully synced all account balances');
  }
}

module.exports = new GhostfolioAPI();
