// Pin the TLS floor process-wide before any client is constructed.
require('./config/tls');

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const https = require('https');
const fs = require('fs');
const path = require('path');
const CircuitBreaker = require('opossum');
const { RateLimiterMemory, RateLimiterQueue } = require('rate-limiter-flexible');
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
  validateApiResponse,
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
    // Validate environment on construction
    const env = validateEnvironment(process.env);
    this.baseURL = env.GHOSTFOLIO_URL.replace(/\/$/, '');
    this.accessToken = null;
    this.configPath = path.join(__dirname, '..', 'config.json');

    this.maxRetries = env.MAX_RETRIES ?? constants.MAX_RETRIES;

    // Rate limiter. Wrapped in a queue so that exceeding the limit makes a request
    // wait for the next slot instead of failing. A bare RateLimiterMemory rejects
    // with a RateLimiterRes — not an Error — which breaks every downstream error
    // path that reads `.message`, and turns a throttle into a lost balance update.
    this.rateLimiter = new RateLimiterQueue(
      new RateLimiterMemory({
        points: constants.RATE_LIMIT_POINTS,
        duration: constants.RATE_LIMIT_DURATION,
      }),
      { maxQueueSize: constants.RATE_LIMIT_MAX_QUEUE }
    );

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
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 50,
        maxFreeSockets: 10,
      }),
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Add retry logic with exponential backoff, clamped so that the total time of a
    // retry chain stays bounded (exponentialDelay honours an unbounded Retry-After).
    axiosRetry(this.axiosInstance, {
      retries: this.maxRetries,
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

    // Create circuit breaker for API calls. The breaker wraps the entire retry
    // chain, so its timeout is derived from that chain's worst case rather than
    // being a fixed value shorter than it. Per-attempt cancellation is axios's
    // own `timeout`, which aborts the socket; the breaker is the outer backstop.
    this.breaker = new CircuitBreaker(this._makeRequest.bind(this), {
      timeout: constants.circuitBreakerTimeoutFor(this.maxRetries),
      errorThresholdPercentage: constants.CIRCUIT_BREAKER_ERROR_THRESHOLD,
      resetTimeout: constants.CIRCUIT_BREAKER_RESET_TIMEOUT,
    });

    this.breaker.on('open', () => {
      logger.error('Circuit breaker opened - too many failures');
      AuditLogger.logSecurityEvent('circuit_breaker_open', 'high', {
        service: 'ghostfolio',
      });
    });

    this.breaker.on('halfOpen', () => {
      logger.info('Circuit breaker half-open - testing recovery');
    });

    this.breaker.on('close', () => {
      logger.info('Circuit breaker closed - service recovered');
    });
  }

  /**
   * Make rate-limited API request
   * @private
   */
  async _makeRequest(config) {
    await this.rateLimiter.removeTokens(1);
    return this.axiosInstance(config);
  }

  /**
   * Make API request with circuit breaker and rate limiting
   * @private
   */
  async _apiRequest(config) {
    return this.breaker.fire(config);
  }

  async authenticate() {
    try {
      const env = validateEnvironment(process.env);

      logger.debug('Authenticating with Ghostfolio...');

      const res = await this._apiRequest({
        method: 'POST',
        url: `${this.baseURL}/api/v1/auth/anonymous`,
        data: {
          accessToken: env.GHOSTFOLIO_TOKEN,
        },
      });

      // Validate response structure
      validateApiResponse(res.data, ['authToken']);

      if (
        !res.data.authToken ||
        typeof res.data.authToken !== 'string' ||
        res.data.authToken.length === 0
      ) {
        AuditLogger.logAuth(false, { service: 'ghostfolio', reason: 'invalid_token' });
        throw new Error('Invalid authentication response: missing or empty authToken');
      }

      this.accessToken = res.data.authToken;
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

      const response = await this._apiRequest({
        method: 'GET',
        url: `${this.baseURL}/api/v1/account`,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      // Validate response structure
      validateApiResponse(response.data, ['accounts']);

      if (!Array.isArray(response.data.accounts)) {
        throw new Error('Invalid API response: accounts must be an array');
      }

      logger.info(`Found ${response.data.accounts.length} Ghostfolio accounts`);
      return response.data.accounts;
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

      const response = await this._apiRequest({
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
