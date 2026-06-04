/**
 * Metrics collection for monitoring and observability
 */

const client = require('prom-client');
const logger = require('../logger');

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics
const syncDuration = new client.Histogram({
  name: 'ghostbudget_sync_duration_seconds',
  help: 'Duration of sync operations in seconds',
  labelNames: ['status'],
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register],
});

const syncErrors = new client.Counter({
  name: 'ghostbudget_sync_errors_total',
  help: 'Total number of sync errors',
  labelNames: ['error_type'],
  registers: [register],
});

const accountsSynced = new client.Counter({
  name: 'ghostbudget_accounts_synced_total',
  help: 'Total number of accounts synced',
  registers: [register],
});

const apiRequests = new client.Counter({
  name: 'ghostbudget_api_requests_total',
  help: 'Total number of API requests',
  labelNames: ['service', 'method', 'status'],
  registers: [register],
});

const apiDuration = new client.Histogram({
  name: 'ghostbudget_api_duration_seconds',
  help: 'Duration of API requests in seconds',
  labelNames: ['service', 'method'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

/**
 * Track sync operation duration
 * @param {Function} fn - Async function to track
 * @returns {Promise<any>} Result of the function
 */
async function trackSyncDuration(fn) {
  const end = syncDuration.startTimer();
  try {
    const result = await fn();
    end({ status: 'success' });
    return result;
  } catch (error) {
    end({ status: 'error' });
    throw error;
  }
}

/**
 * Record sync error
 * @param {string} errorType - Type of error
 */
function recordSyncError(errorType) {
  syncErrors.inc({ error_type: errorType });
}

/**
 * Record accounts synced
 * @param {number} count - Number of accounts synced
 */
function recordAccountsSynced(count) {
  accountsSynced.inc(count);
}

/**
 * Track API request
 * @param {string} service - Service name (e.g., 'ghostfolio', 'actualbudget')
 * @param {string} method - HTTP method
 * @param {Function} fn - Async function to track
 * @returns {Promise<any>} Result of the function
 */
async function trackApiRequest(service, method, fn) {
  const end = apiDuration.startTimer({ service, method });
  try {
    const result = await fn();
    apiRequests.inc({ service, method, status: 'success' });
    end();
    return result;
  } catch (error) {
    apiRequests.inc({ service, method, status: 'error' });
    end();
    throw error;
  }
}

/**
 * Get metrics in Prometheus format
 * @returns {Promise<string>} Metrics string
 */
async function getMetrics() {
  try {
    return await register.metrics();
  } catch (error) {
    logger.error('Failed to get metrics', { error: error.message });
    return '';
  }
}

/**
 * Get metrics registry
 * @returns {client.Registry} Metrics registry
 */
function getRegistry() {
  return register;
}

module.exports = {
  trackSyncDuration,
  recordSyncError,
  recordAccountsSynced,
  trackApiRequest,
  getMetrics,
  getRegistry,
  // Export individual metrics for testing
  syncDuration,
  syncErrors,
  accountsSynced,
  apiRequests,
  apiDuration,
};

// Made with Bob
