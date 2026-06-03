require('dotenv').config();
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
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

    // Create secure axios instance
    this.axiosInstance = axios.create({
      timeout: 30000, // 30 second timeout
      maxContentLength: 10 * 1024 * 1024, // 10MB max
      maxBodyLength: 10 * 1024 * 1024,
      httpsAgent: new https.Agent({
        rejectUnauthorized: true, // Enforce certificate validation
        minVersion: 'TLSv1.2', // Minimum TLS version
      }),
    });
  }

  async authenticate() {
    try {
      const env = validateEnvironment(process.env);

      logger.debug('Authenticating with Ghostfolio...');
      const res = await this.axiosInstance.post(`${this.baseURL}/api/v1/auth/anonymous`, {
        accessToken: env.GHOSTFOLIO_TOKEN,
      });

      // Validate response structure
      validateApiResponse(res.data, ['authToken']);

      if (
        !res.data.authToken ||
        typeof res.data.authToken !== 'string' ||
        res.data.authToken.length === 0
      ) {
        throw new Error('Invalid authentication response: missing or empty authToken');
      }

      this.accessToken = res.data.authToken;
      logger.info('Successfully authenticated with Ghostfolio');
    } catch (error) {
      logger.error('Failed to authenticate with Ghostfolio', sanitizeError(error));
      throw error;
    }
  }

  async getGhostfolioAccounts() {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first');
    }

    try {
      logger.debug('Fetching Ghostfolio accounts...');
      const response = await this.axiosInstance.get(`${this.baseURL}/api/v1/account`, {
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

      const response = await this.axiosInstance.put(
        `${this.baseURL}/api/v1/account/${ghostfolioAccount.id}`,
        updateData,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      logger.info(`Successfully updated balance for account ${ghostfolioAccount.name}`);
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

        const factor = mapping.factor !== undefined ? validateBalance(mapping.factor) : 1;

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
