/**
 * Audit logging for security events
 * Tracks authentication, authorization, and data changes
 */

const logger = require('../logger');
const { v4: uuidv4 } = require('uuid');

class AuditLogger {
  /**
   * Log authentication attempt
   * @param {boolean} success - Whether authentication succeeded
   * @param {Object} details - Additional details
   */
  static logAuth(success, details = {}) {
    logger.info('Authentication attempt', {
      event: 'auth',
      event_id: uuidv4(),
      success,
      timestamp: new Date().toISOString(),
      service: details.service || 'unknown',
      ...details,
    });
  }

  /**
   * Log balance update
   * @param {string} account - Account name
   * @param {boolean} changed - Whether balance changed
   * @param {Object} details - Additional details
   */
  static logBalanceUpdate(account, changed, details = {}) {
    logger.info('Balance update', {
      event: 'balance_update',
      event_id: uuidv4(),
      account,
      changed,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  /**
   * Log sync operation
   * @param {string} status - Status of sync (started, completed, failed)
   * @param {Object} details - Additional details
   */
  static logSync(status, details = {}) {
    const logLevel = status === 'failed' ? 'error' : 'info';
    logger[logLevel]('Sync operation', {
      event: 'sync',
      event_id: uuidv4(),
      status,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  /**
   * Log configuration change
   * @param {string} changeType - Type of configuration change
   * @param {Object} details - Additional details
   */
  static logConfigChange(changeType, details = {}) {
    logger.info('Configuration change', {
      event: 'config_change',
      event_id: uuidv4(),
      change_type: changeType,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  /**
   * Log security event
   * @param {string} eventType - Type of security event
   * @param {string} severity - Severity level (low, medium, high, critical)
   * @param {Object} details - Additional details
   */
  static logSecurityEvent(eventType, severity, details = {}) {
    const logLevel = severity === 'critical' || severity === 'high' ? 'error' : 'warn';
    logger[logLevel]('Security event', {
      event: 'security',
      event_id: uuidv4(),
      event_type: eventType,
      severity,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  /**
   * Log API request
   * @param {string} service - Service name
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {number} statusCode - Response status code
   * @param {number} duration - Request duration in ms
   */
  static logApiRequest(service, method, endpoint, statusCode, duration) {
    logger.debug('API request', {
      event: 'api_request',
      event_id: uuidv4(),
      service,
      method,
      endpoint,
      status_code: statusCode,
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log validation failure
   * @param {string} validationType - Type of validation that failed
   * @param {Object} details - Additional details
   */
  static logValidationFailure(validationType, details = {}) {
    logger.warn('Validation failure', {
      event: 'validation_failure',
      event_id: uuidv4(),
      validation_type: validationType,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }
}

module.exports = AuditLogger;

// Made with Bob
