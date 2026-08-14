/**
 * Audit logging for security events
 * Tracks authentication, authorization, and data changes
 *
 * Every method here is a thin, named wrapper over one winston call. The value is
 * the vocabulary — a fixed set of `event` names and payload shapes, chosen in one
 * place rather than spelled out at thirty call sites — and the level routing, which
 * decides whether an event reaches logs/error.log at all.
 *
 * No payload carries its own `timestamp` or event id. winston's `format.timestamp()`
 * already puts one on every record, and the per-process `correlationId` from logger.js
 * is the identifier a run is addressed by — there is no separate audit sink, and no
 * query that needs to address one event rather than one run. See docs/decisions.md.
 */

const logger = require('../logger');

class AuditLogger {
  /**
   * Log authentication attempt
   * @param {boolean} success - Whether authentication succeeded
   * @param {Object} details - Additional details
   */
  static logAuth(success, details = {}) {
    logger.info('Authentication attempt', {
      event: 'auth',
      success,
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
      account,
      changed,
      ...details,
    });
  }

  /**
   * Log sync operation
   * @param {string} status - Status of sync (started, completed, failed)
   * @param {Object} details - Additional details
   */
  static logSync(status, details = {}) {
    const payload = { event: 'sync', status, ...details };

    // Branching rather than logger[level](): a computed method name on an object
    // is the pattern that turns a tainted string into an arbitrary call, and
    // there is no reason to spend that risk on two fixed levels.
    if (status === 'failed') {
      logger.error('Sync operation', payload);
    } else {
      logger.info('Sync operation', payload);
    }
  }

  /**
   * Log security event
   * @param {string} eventType - Type of security event
   * @param {string} severity - Severity level (low, medium, high, critical)
   * @param {Object} details - Additional details
   */
  static logSecurityEvent(eventType, severity, details = {}) {
    const payload = { event: 'security', event_type: eventType, severity, ...details };

    if (severity === 'critical' || severity === 'high') {
      logger.error('Security event', payload);
    } else {
      logger.warn('Security event', payload);
    }
  }

  /**
   * Log validation failure
   * @param {string} validationType - Type of validation that failed
   * @param {Object} details - Additional details
   */
  static logValidationFailure(validationType, details = {}) {
    logger.warn('Validation failure', {
      event: 'validation_failure',
      validation_type: validationType,
      ...details,
    });
  }
}

module.exports = AuditLogger;
