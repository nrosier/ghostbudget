// The sync orchestration decides what the audit trail says about a run, and it is
// the one place a non-Error rejection can destroy both the failure and the event
// that records it. Everything below the orchestration is mocked out.
jest.mock('../src/actualBudget', () => ({ getAccountBalances: jest.fn() }));
jest.mock('../src/ghostfolio', () => ({ syncAccountBalances: jest.fn() }));
jest.mock('../src/utils/audit', () => ({
  logSync: jest.fn(),
  logAuth: jest.fn(),
  logBalanceUpdate: jest.fn(),
  logSecurityEvent: jest.fn(),
  logValidationFailure: jest.fn(),
}));
// index.js installs process handlers that exit on an unhandled rejection. Stubbing
// the exit helper keeps a stray rejection in one test from tearing down the runner.
jest.mock('../src/utils/exit', () => ({ flushLogsAndExit: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAccountBalances } = require('../src/actualBudget');
const ghostfolio = require('../src/ghostfolio');
const AuditLogger = require('../src/utils/audit');
const { sync } = require('../src/index');

/**
 * The details object of the logSync call with a given status.
 *
 * @param {string} status - 'started', 'completed' or 'failed'
 * @returns {Object|undefined} Logged details
 */
function syncEvent(status) {
  const call = AuditLogger.logSync.mock.calls.find(([recorded]) => recorded === status);
  return call && call[1];
}

describe('sync', () => {
  const balances = [
    { name: 'Main Savings', balance: 100012 },
    { name: 'Brokerage Account', balance: 100084 },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches balances, forwards them, and audits a completed run', async () => {
    getAccountBalances.mockResolvedValue(balances);
    ghostfolio.syncAccountBalances.mockResolvedValue(undefined);

    await expect(sync()).resolves.toBe(true);

    expect(ghostfolio.syncAccountBalances).toHaveBeenCalledWith(balances);
    // No details on 'started': it used to carry a timestamp, which winston's own
    // format.timestamp() already puts on every record. The event is the whole
    // signal, and the correlation ID ties it to the rest of the run.
    expect(AuditLogger.logSync).toHaveBeenCalledWith('started');
    expect(syncEvent('completed')).toMatchObject({ accounts_synced: 2 });
    expect(syncEvent('completed').duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not record account balances in the audit trail', async () => {
    getAccountBalances.mockResolvedValue(balances);
    ghostfolio.syncAccountBalances.mockResolvedValue(undefined);

    await sync();

    const serialized = JSON.stringify(AuditLogger.logSync.mock.calls);
    expect(serialized).not.toContain('100012');
    expect(serialized).not.toContain('100084');
  });

  it('refuses to sync an empty balance list', async () => {
    // An empty list means the Actual Budget fetch went wrong; pushing it onward
    // would be a no-op at best and is not a successful run.
    getAccountBalances.mockResolvedValue([]);

    await expect(sync()).rejects.toThrow(/No balances received/);

    expect(ghostfolio.syncAccountBalances).not.toHaveBeenCalled();
    expect(syncEvent('failed')).toMatchObject({ error_type: 'unknown_error' });
  });

  it('refuses a response that is not an array', async () => {
    getAccountBalances.mockResolvedValue({ accounts: [] });

    await expect(sync()).rejects.toThrow(/No balances received/);
    expect(ghostfolio.syncAccountBalances).not.toHaveBeenCalled();
  });

  it('classifies an authentication failure', async () => {
    getAccountBalances.mockRejectedValue(new Error('Ghostfolio authentication rejected'));

    await expect(sync()).rejects.toThrow(/authentication rejected/);

    expect(syncEvent('failed')).toMatchObject({ error_type: 'auth_error' });
  });

  it('classifies a network failure', async () => {
    getAccountBalances.mockRejectedValue(new Error('network unreachable'));

    await expect(sync()).rejects.toThrow(/network unreachable/);

    expect(syncEvent('failed')).toMatchObject({ error_type: 'network_error' });
  });

  it('survives a rejection that carries no message', async () => {
    // Classifying with `error.message.includes(...)` on one of these throws a
    // TypeError from inside the catch block, losing the original failure and the
    // audit event with it.
    for (const rejection of [null, undefined, { status: 500 }, 'plain string']) {
      jest.clearAllMocks();
      getAccountBalances.mockRejectedValue(rejection);

      await expect(sync()).rejects.toBe(rejection);

      const failure = syncEvent('failed');
      expect(failure).toBeDefined();
      expect(typeof failure.error).toBe('string');
      expect(failure.error_type).toBe('unknown_error');
    }
  });

  it('redacts a secret that reached the error message', async () => {
    process.env.GHOSTFOLIO_TOKEN = 'token-that-must-not-leak';
    try {
      getAccountBalances.mockRejectedValue(
        new Error('rejected token-that-must-not-leak by upstream')
      );

      await expect(sync()).rejects.toThrow();

      expect(syncEvent('failed').error).not.toContain('token-that-must-not-leak');
    } finally {
      delete process.env.GHOSTFOLIO_TOKEN;
    }
  });

  it('audits a failure that happens during the Ghostfolio leg', async () => {
    getAccountBalances.mockResolvedValue(balances);
    ghostfolio.syncAccountBalances.mockRejectedValue(new Error('Failed to sync 1 account(s)'));

    await expect(sync()).rejects.toThrow(/Failed to sync 1 account/);

    expect(syncEvent('completed')).toBeUndefined();
    expect(syncEvent('failed')).toBeDefined();
  });
});

describe('process handlers', () => {
  // These are registered as a side effect of requiring index.js, so each case loads
  // its own copy: the shutdown path is guarded by module-level state, and a shared
  // instance would let the first test consume the guard for every one after it.
  const EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'];
  let logDir;
  let loaded;

  /**
   * Load a fresh index.js and isolate the handlers it just registered.
   *
   * @returns {{handlerFor: Function, logger: Object, exit: Function, remove: Function}} Handles
   */
  function loadIndex() {
    const existing = new Map(EVENTS.map((event) => [event, process.listeners(event)]));

    jest.resetModules();
    const logger = require('../src/logger');
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    // After resetModules the mock factory runs again, so this is a different jest.fn()
    // from the one the top-level require holds. Take the one index.js will call.
    const { flushLogsAndExit: exit } = require('../src/utils/exit');
    require('../src/index');

    const added = new Map(
      EVENTS.map((event) => [
        event,
        process.listeners(event).filter((listener) => !existing.get(event).includes(listener)),
      ])
    );

    return {
      handlerFor: (event) => {
        expect(added.get(event)).toHaveLength(1);
        return added.get(event)[0];
      },
      logger,
      exit,
      // Registering on every load would otherwise pile up listeners across tests
      // and trip Node's MaxListenersExceededWarning.
      remove: () =>
        added.forEach((listeners, event) =>
          listeners.forEach((listener) => process.removeListener(event, listener))
        ),
    };
  }

  beforeAll(() => {
    // A fresh logger per load builds real Winston file transports; keep them out of
    // the repository's logs/ directory.
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-index-logs-'));
    process.env.GHOSTBUDGET_LOG_DIR = logDir;
  });

  afterAll(() => {
    delete process.env.GHOSTBUDGET_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    loaded = loadIndex();
  });

  afterEach(() => {
    loaded.remove();
  });

  it.each([['SIGTERM'], ['SIGINT']])('shuts down cleanly on %s', async (signal) => {
    await loaded.handlerFor(signal)(signal);

    expect(loaded.logger.info).toHaveBeenCalledWith(expect.stringContaining(`Received ${signal}`));
    expect(loaded.exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second signal instead of shutting down twice', async () => {
    // Docker sends SIGTERM and then SIGKILL, but an operator hitting Ctrl-C twice
    // would otherwise run the whole cleanup path concurrently with itself.
    const shutdown = loaded.handlerFor('SIGTERM');

    await shutdown('SIGTERM');
    await shutdown('SIGTERM');

    expect(loaded.exit).toHaveBeenCalledTimes(1);
  });

  it('exits non-zero on an unhandled rejection', async () => {
    loaded.handlerFor('unhandledRejection')(new Error('nothing awaited this'));

    expect(loaded.logger.error).toHaveBeenCalledWith(
      'Unhandled Rejection',
      expect.objectContaining({ message: expect.stringContaining('nothing awaited this') })
    );
    expect(loaded.exit).toHaveBeenCalledWith(1);
  });

  it('survives an unhandled rejection with no Error at all', async () => {
    // `reason` is whatever was thrown; sanitizeError has to cope with a bare value
    // or the handler itself throws and the process dies with no log line.
    for (const reason of [undefined, null, 'a string', 42]) {
      expect(() => loaded.handlerFor('unhandledRejection')(reason)).not.toThrow();
    }

    expect(loaded.logger.error).toHaveBeenCalledTimes(4);
  });

  it('exits non-zero on an uncaught exception', async () => {
    loaded.handlerFor('uncaughtException')(new Error('boom'));

    expect(loaded.logger.error).toHaveBeenCalledWith(
      'Uncaught Exception',
      expect.objectContaining({ message: expect.stringContaining('boom') })
    );
    expect(loaded.exit).toHaveBeenCalledWith(1);
  });

  it('redacts a credential that reached an uncaught exception', async () => {
    process.env.ACTUAL_BUDGET_PASS = 'pass-that-must-not-leak';
    try {
      loaded.handlerFor('uncaughtException')(new Error('login failed: pass-that-must-not-leak'));

      const [, details] = loaded.logger.error.mock.calls[0];
      expect(JSON.stringify(details)).not.toContain('pass-that-must-not-leak');
    } finally {
      delete process.env.ACTUAL_BUDGET_PASS;
    }
  });
});
