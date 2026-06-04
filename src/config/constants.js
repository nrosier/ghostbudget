/**
 * Application constants
 * Centralized configuration values for the application
 */

module.exports = {
  // HTTP Configuration
  HTTP_TIMEOUT_MS: 30000, // 30 seconds
  MAX_CONTENT_LENGTH_BYTES: 10 * 1024 * 1024, // 10MB
  MAX_BODY_LENGTH_BYTES: 10 * 1024 * 1024, // 10MB

  // Logging Configuration
  LOG_MAX_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  LOG_MAX_FILES: 5,

  // Performance Configuration
  CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  BATCH_SIZE: 10, // Process accounts in batches of 10
  MAX_RETRIES: 3, // Maximum retry attempts

  // Rate Limiting Configuration
  RATE_LIMIT_POINTS: 10, // 10 requests
  RATE_LIMIT_DURATION: 1, // per 1 second

  // Circuit Breaker Configuration
  CIRCUIT_BREAKER_TIMEOUT: 30000, // 30 seconds
  CIRCUIT_BREAKER_ERROR_THRESHOLD: 50, // 50% error rate
  CIRCUIT_BREAKER_RESET_TIMEOUT: 30000, // 30 seconds

  // TLS Configuration
  TLS_MIN_VERSION: 'TLSv1.2',
  TLS_MAX_VERSION: 'TLSv1.3',
  TLS_CIPHERS: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
  ].join(':'),

  // Validation Configuration
  MAX_ACCOUNT_NAME_LENGTH: 255,
  MIN_PASSWORD_LENGTH: 1,
  MIN_TOKEN_LENGTH: 1,

  // Metrics Configuration
  METRICS_PORT: 3000,
  HEALTH_CHECK_INTERVAL_MS: 30000, // 30 seconds
};

// Made with Bob
