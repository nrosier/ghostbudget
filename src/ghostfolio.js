const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const https = require('https');
const fs = require('fs');
const path = require('path');
const CircuitBreaker = require('opossum');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const constants = require('./config/constants');
const {
  validateConfig,
  validateEnvironment,
  validateBalance,
  validateAccountName,
  sanitizeError,
  validateApiResponse,
} = require('./utils/validation');

class GhostfolioAPI {
  constructor() {
    // Validate environment on construction
    const env = validateEnvironment(process.env);
    this.baseURL = env.GHOSTFOLIO_URL.replace(/\/$/, '');
    this.accessToken = null;
    this.configPath = path.join(__dirname, '..', 'config.json');

    // Cache configuration
    this.accountsCache = null;
    this.accountsCacheExpiry = null;
    this.cacheTTL = (env.CACHE_TTL_MINUTES || 5) * 60 * 1000;

    // Rate limiter
    this.rateLimiter = new RateLimiterMemory({
      points: constants.RATE_LIMIT_POINTS,
      duration: constants.RATE_LIMIT_DURATION,
    });

    // Create secure axios instance with enhanced TLS
    this.axiosInstance = axios.create({
      timeout: constants.HTTP_TIMEOUT_MS,
      maxContentLength: constants.MAX_CONTENT_LENGTH_BYTES,
      maxBodyLength: constants.MAX_BODY_LENGTH_BYTES,
      httpsAgent: new https.Agent({
        rejectUnauthorized: true,
        minVersion: constants.TLS_MIN_VERSION,
        maxVersion: constants.TLS_MAX_VERSION,
        ciphers: constants.TLS_CIPHERS,
        honorCipherOrder: true,
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 50,
        maxFreeSockets: 10,
      }),
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Add retry logic with exponential backoff
    axiosRetry(this.axiosInstance, {
      retries: env.MAX_RETRIES || constants.MAX_RETRIES,
      retryDelay: axiosRetry.exponentialDelay,
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

    // Create circuit breaker for API calls
    this.breaker = new CircuitBreaker(this._makeRequest.bind(this), {
      timeout: constants.CIRCUIT_BREAKER_TIMEOUT,
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
    await this.rateLimiter.consume('ghostfolio-api');
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
      AuditLogger.logAuth(false, { service: 'ghostfolio', error: error.message });
      throw error;
    }
  }

  async getGhostfolioAccounts() {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first');
    }

    // Check cache first
    const now = Date.now();
    if (this.accountsCache && this.accountsCacheExpiry > now) {
      logger.debug('Using cached Ghostfolio accounts');
      return this.accountsCache;
    }

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

      // Cache the results
      this.accountsCache = response.data.accounts;
      this.accountsCacheExpiry = now + this.cacheTTL;

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
      const validatedFactor = validateBalance(factor);

      const newBalance = (validatedBalance * validatedFactor) / 100;

      logger.debug('Updating account balance', {
        account: ghostfolioAccount.name,
        // Don't log actual balance values in production
      });

      const updateData = {
        balance: newBalance,
        comment: ghostfolioAccount.comment || '',
        currency: ghostfolioAccount.currency,
        id: ghostfolioAccount.id,
        isExcluded: ghostfolioAccount.isExcluded || false,
        name: ghostfolioAccount.name,
        platformId: ghostfolioAccount.platformId || null,
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
      AuditLogger.logBalanceUpdate(ghostfolioAccount.name, true, {
        service: 'ghostfolio',
      });

      // Invalidate cache after update
      this.accountsCache = null;
      this.accountsCacheExpiry = null;

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
      const configContent = fs.readFileSync(this.configPath, 'utf8');
      configData = JSON.parse(configContent);
    } catch (error) {
      logger.error('Failed to read or parse config file', sanitizeError(error));
      throw new Error(`Config file error: ${error.message}`);
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

        // config validation guarantees factor is a positive number (default 1)
        const factor = validateBalance(mapping.factor);

        await this.updateAccountBalance(ghostfolioAccount, actualAccount.balance, factor);
      } catch (error) {
        logger.error('Account sync failed', sanitizeError(error));
        errors.push(error.message);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to sync ${errors.length} account(s): ${errors.join('; ')}`);
    }

    logger.info('Successfully synced all account balances');
  }
}

module.exports = new GhostfolioAPI();
