// The audit trail is a control in its own right: if a security event is written
// at the wrong level it does not reach the error log, and if a balance value or a
// severity string can steer the call, the trail is not trustworthy. These tests
// pin the routing and the payload rather than the wording of the messages.
jest.mock('../src/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

// A plain function rather than jest.fn(): clearMocks resets implementations before
// every test, which would make the shared uuid mock return undefined and hide
// whether an event carries an id at all.
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

const logger = require('../src/logger');
const AuditLogger = require('../src/utils/audit');

/**
 * The metadata object passed to the winston call that was made.
 *
 * @param {Object} mockFn - A jest mock for one of the logger levels
 * @returns {Object} The logged payload
 */
function payloadOf(mockFn) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  return mockFn.mock.calls[0][1];
}

describe('AuditLogger.logAuth', () => {
  it('records success and the service at info level', () => {
    AuditLogger.logAuth(true, { service: 'ghostfolio' });

    const payload = payloadOf(logger.info);
    expect(payload).toMatchObject({ event: 'auth', success: true, service: 'ghostfolio' });
    expect(payload.event_id).toBeTruthy();
    expect(payload.timestamp).toBeTruthy();
  });

  it('records a failure as success: false rather than omitting it', () => {
    AuditLogger.logAuth(false, { service: 'ghostfolio', reason: 'invalid_token' });

    expect(payloadOf(logger.info)).toMatchObject({ success: false, reason: 'invalid_token' });
  });

  it('falls back to an explicit unknown service', () => {
    AuditLogger.logAuth(true);

    expect(payloadOf(logger.info).service).toBe('unknown');
  });
});

describe('AuditLogger.logBalanceUpdate', () => {
  it('records the account and whether the balance actually changed', () => {
    AuditLogger.logBalanceUpdate('Main Savings', false, { service: 'ghostfolio' });

    expect(payloadOf(logger.info)).toMatchObject({
      event: 'balance_update',
      account: 'Main Savings',
      changed: false,
    });
  });

  it('does not invent a balance field', () => {
    // The event says a balance changed, never what it changed to: logs/combined.log
    // is a mounted volume read by whoever debugs the container.
    AuditLogger.logBalanceUpdate('Main Savings', true, { service: 'ghostfolio' });

    const payload = payloadOf(logger.info);
    expect(payload.balance).toBeUndefined();
    expect(payload.newBalance).toBeUndefined();
    expect(payload.previousBalance).toBeUndefined();
  });
});

describe('AuditLogger.logSync', () => {
  it('routes a failed sync to error level', () => {
    // A sync failure that lands at info level never reaches logs/error.log, which
    // is the file an operator actually looks at.
    AuditLogger.logSync('failed', { error: 'boom', error_type: 'unknown_error' });

    expect(logger.info).not.toHaveBeenCalled();
    expect(payloadOf(logger.error)).toMatchObject({
      event: 'sync',
      status: 'failed',
      error_type: 'unknown_error',
    });
  });

  it('routes started and completed to info level', () => {
    for (const status of ['started', 'completed']) {
      jest.clearAllMocks();
      AuditLogger.logSync(status, { duration_ms: 1 });

      expect(logger.error).not.toHaveBeenCalled();
      expect(payloadOf(logger.info)).toMatchObject({ status });
    }
  });

  it('cannot be steered into calling an arbitrary logger method', () => {
    // The level used to be selected with logger[level](), so a status of
    // 'constructor' or 'toString' resolved to something that is not a log method.
    // The branch is now explicit, so any unrecognized status is simply info.
    for (const status of ['constructor', 'toString', '__proto__', 'valueOf']) {
      jest.clearAllMocks();
      expect(() => AuditLogger.logSync(status)).not.toThrow();

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    }
  });
});

describe('AuditLogger.logSecurityEvent', () => {
  it('routes critical and high severities to error level', () => {
    for (const severity of ['critical', 'high']) {
      jest.clearAllMocks();
      AuditLogger.logSecurityEvent('circuit_breaker_open', severity, { service: 'ghostfolio' });

      expect(logger.warn).not.toHaveBeenCalled();
      expect(payloadOf(logger.error)).toMatchObject({
        event: 'security',
        event_type: 'circuit_breaker_open',
        severity,
      });
    }
  });

  it('routes lower severities to warn level', () => {
    for (const severity of ['medium', 'low']) {
      jest.clearAllMocks();
      AuditLogger.logSecurityEvent('xss_attempt', severity, { input: 'account_name' });

      expect(logger.error).not.toHaveBeenCalled();
      expect(payloadOf(logger.warn)).toMatchObject({ severity, input: 'account_name' });
    }
  });

  it('cannot be steered into calling an arbitrary logger method', () => {
    for (const severity of ['constructor', 'toString', '__proto__', undefined]) {
      jest.clearAllMocks();
      expect(() => AuditLogger.logSecurityEvent('probe', severity)).not.toThrow();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    }
  });
});

describe('AuditLogger.logValidationFailure', () => {
  it('records the validation type at warn level', () => {
    AuditLogger.logValidationFailure('account_name', { reason: 'too_long', length: 999 });

    expect(payloadOf(logger.warn)).toMatchObject({
      event: 'validation_failure',
      validation_type: 'account_name',
      reason: 'too_long',
    });
  });
});
