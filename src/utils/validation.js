const Joi = require('joi');
const logger = require('../logger');

/**
 * Schema for validating config.json structure
 */
const configSchema = Joi.object({
  accounts: Joi.array()
    .items(
      Joi.object({
        ghostfolioName: Joi.string().trim().min(1).max(255).required(),
        actualBudgetName: Joi.string().trim().min(1).max(255).required(),
        factor: Joi.number().positive().default(1),
      })
    )
    .min(1)
    .required(),
}).required();

/**
 * Schema for validating environment variables
 */
const envSchema = Joi.object({
  ACTUAL_BUDGET_URL: Joi.string().uri().required(),
  ACTUAL_BUDGET_PASS: Joi.string().min(1).required(),
  ACTUAL_BUDGET_SYNC_ID: Joi.string().min(1).required(),
  ACTUAL_BUDGET_DATA_DIR: Joi.string().allow('').optional(),
  GHOSTFOLIO_URL: Joi.string().uri().required(),
  GHOSTFOLIO_TOKEN: Joi.string().min(1).required(),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),
}).unknown(true); // Allow other env vars

/**
 * Validate configuration object
 * @param {Object} config - Configuration object to validate
 * @returns {Object} Validated and sanitized configuration
 * @throws {Error} If validation fails
 */
function validateConfig(config) {
  const { error, value } = configSchema.validate(config, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const details = error.details.map((d) => d.message).join('; ');
    logger.error('Configuration validation failed', { details });
    throw new Error(`Invalid configuration: ${details}`);
  }

  logger.debug('Configuration validated successfully');
  return value;
}

/**
 * Validate environment variables
 * @param {Object} env - Environment variables object (typically process.env)
 * @returns {Object} Validated environment variables
 * @throws {Error} If validation fails
 */
function validateEnvironment(env) {
  const { error, value } = envSchema.validate(env, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const details = error.details.map((d) => d.message).join('; ');
    logger.error('Environment validation failed', { details });
    throw new Error(`Invalid environment variables: ${details}`);
  }

  // Validate URLs are HTTPS in production
  if (value.NODE_ENV === 'production') {
    if (!value.ACTUAL_BUDGET_URL.startsWith('https://')) {
      throw new Error('ACTUAL_BUDGET_URL must use HTTPS in production');
    }
    if (!value.GHOSTFOLIO_URL.startsWith('https://')) {
      throw new Error('GHOSTFOLIO_URL must use HTTPS in production');
    }
  }

  logger.debug('Environment variables validated successfully');
  return value;
}

/**
 * Validate account balance
 * @param {*} balance - Balance value to validate
 * @returns {number} Validated balance
 * @throws {Error} If validation fails
 */
function validateBalance(balance) {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    throw new Error(`Invalid balance: must be a finite number, got ${typeof balance}`);
  }
  return balance;
}

/**
 * Validate account name
 * @param {*} name - Account name to validate
 * @returns {string} Validated and sanitized name
 * @throws {Error} If validation fails
 */
function validateAccountName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Account name must be a non-empty string');
  }
  if (name.length > 255) {
    throw new Error('Account name must not exceed 255 characters');
  }
  return name.trim();
}

/**
 * Sanitize error for logging (remove sensitive data)
 * @param {Error} error - Error object
 * @returns {Object} Sanitized error object safe for logging
 */
function sanitizeError(error) {
  return {
    message: error.message,
    code: error.code,
    name: error.name,
    // Explicitly exclude stack trace and other potentially sensitive data
  };
}

/**
 * Validate API response structure
 * @param {*} response - API response to validate
 * @param {Array<string>} requiredFields - Required fields in response
 * @returns {Object} Validated response
 * @throws {Error} If validation fails
 */
function validateApiResponse(response, requiredFields = []) {
  if (!response || typeof response !== 'object') {
    throw new Error('Invalid API response: must be an object');
  }

  for (const field of requiredFields) {
    if (!(field in response)) {
      throw new Error(`Invalid API response: missing required field '${field}'`);
    }
  }

  return response;
}

module.exports = {
  validateConfig,
  validateEnvironment,
  validateBalance,
  validateAccountName,
  sanitizeError,
  validateApiResponse,
};

// Made with Bob
