const api = require('@actual-app/api');

const constants = require('../src/config/constants');
const { applyTestEnv } = require('./helpers/env');

// Mock the actual-api module
jest.mock('@actual-app/api');

// A transient failure as Node reports one, which is what getAccountBalances retries.
function refused() {
  const error = new Error('connect ECONNREFUSED 127.0.0.1:5006');
  error.code = 'ECONNREFUSED';
  return error;
}

describe('actualBudget', () => {
  let actualBudget;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    applyTestEnv();

    // Import the module in each test to get a fresh instance
    actualBudget = require('../src/actualBudget');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Run a sync with the retry backoff fast-forwarded.
   *
   * The delays double from RETRY_BASE_DELAY_MS, so a suite that waited for them really
   * would spend seven seconds per retrying test and blow Jest's own timeout. One pass per
   * possible attempt, each long enough to clear the capped delay, settles every case.
   *
   * @returns {Promise<Array>} Whatever the sync resolved or rejected with
   */
  async function syncWithoutWaiting() {
    jest.useFakeTimers();
    const pending = actualBudget.getAccountBalances();
    // Attached now so a rejection between advances is never an unhandled one.
    pending.catch(() => {});

    for (let i = 0; i <= constants.MAX_RETRIES + 1; i += 1) {
      await jest.advanceTimersByTimeAsync(constants.MAX_RETRY_DELAY_MS);
    }

    return pending;
  }

  describe('getAccountBalances', () => {
    it('should return account balances when successful', async () => {
      // Mock successful API responses
      api.init.mockResolvedValue();
      api.downloadBudget.mockResolvedValue();
      api.getAccounts.mockResolvedValue([{ id: '1', name: 'Checking' }]);
      api.getAccountBalance.mockResolvedValue(100012);
      api.shutdown.mockResolvedValue();

      const balances = await actualBudget.getAccountBalances();

      expect(balances).toEqual([{ name: 'Checking', balance: 100012 }]);
    });

    it('should preserve account names containing special characters', async () => {
      // Names with characters such as & must not be mangled, otherwise they
      // will fail to match the account list returned by Ghostfolio.
      api.init.mockResolvedValue();
      api.downloadBudget.mockResolvedValue();
      api.getAccounts.mockResolvedValue([{ id: '1', name: 'AT&T Stock' }]);
      api.getAccountBalance.mockResolvedValue(100012);
      api.shutdown.mockResolvedValue();

      const balances = await actualBudget.getAccountBalances();

      expect(balances).toEqual([{ name: 'AT&T Stock', balance: 100012 }]);
    });

    it('should throw when required environment variables are missing', async () => {
      delete process.env.ACTUAL_BUDGET_URL;

      await expect(actualBudget.getAccountBalances()).rejects.toThrow(
        /Invalid environment variables/
      );
    });

    it('should throw when API initialization fails', async () => {
      api.init.mockRejectedValue(new Error('Connection failed'));

      await expect(actualBudget.getAccountBalances()).rejects.toThrow('Connection failed');

      // Once, not four times. The retry allowlist covers transient failures only, so a
      // wrong password or an unwritable data directory still fails on the first attempt
      // rather than being attempted repeatedly against the server.
      expect(api.init).toHaveBeenCalledTimes(1);
    });

    it('rejects an account list that is not an array', async () => {
      // Everything downstream maps over this value. Without the guard, a non-array
      // reaches .map() and fails as a TypeError about `map` rather than about the
      // response that was actually wrong.
      api.init.mockResolvedValue();
      api.downloadBudget.mockResolvedValue();
      api.shutdown.mockResolvedValue();

      for (const accounts of [null, undefined, { accounts: [] }, 'one']) {
        api.getAccounts.mockResolvedValue(accounts);

        await expect(actualBudget.getAccountBalances()).rejects.toThrow(
          /expected array|Invalid response from getAccounts/
        );
      }

      expect(api.getAccountBalance).not.toHaveBeenCalled();
    });

    it('points at the likely cause when the remote files cannot be listed', async () => {
      // This is what a wrong sync ID or a wrong password looks like coming out of
      // @actual-app/api, and the raw message says nothing about either.
      api.init.mockRejectedValue(new Error('Could not get remote files'));
      api.shutdown.mockResolvedValue();

      const logger = require('../src/logger');
      const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
      jest.spyOn(logger, 'warn').mockImplementation(() => {});

      await expect(syncWithoutWaiting()).rejects.toThrow(/Could not get remote files/);

      expect(error).toHaveBeenCalledWith(expect.stringMatching(/Verify server URL, sync ID/));
    });
  });

  // The Ghostfolio leg has axios-retry. This one had nothing at all, so a server that
  // was still starting up when the scheduled sync fired failed the whole run.
  describe('getAccountBalances retry', () => {
    beforeEach(() => {
      api.getAccounts.mockResolvedValue([{ id: '1', name: 'Checking' }]);
      api.getAccountBalance.mockResolvedValue(100012);
      api.downloadBudget.mockResolvedValue();
      api.shutdown.mockResolvedValue();

      const logger = require('../src/logger');
      jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    it('retries a refused connection and syncs on the next attempt', async () => {
      api.init.mockRejectedValueOnce(refused()).mockResolvedValue();

      await expect(syncWithoutWaiting()).resolves.toEqual([{ name: 'Checking', balance: 100012 }]);

      expect(api.init).toHaveBeenCalledTimes(2);
    });

    it('closes the half-open connection before initializing again', async () => {
      // @actual-app/api holds a server session and a local SQLite handle. Calling init()
      // on top of one that failed part-way is how a retry turns a transient failure into
      // corrupt local state, so every attempt after the first starts from a clean close.
      api.init.mockRejectedValueOnce(refused()).mockResolvedValue();

      await syncWithoutWaiting();

      // Once between the attempts, once in the `finally`.
      expect(api.shutdown).toHaveBeenCalledTimes(2);
    });

    it('retries a budget download that fails transiently, with a fresh session', async () => {
      // The download reads the budget over the network, so it fails for the same
      // transient reasons the connect does and gets the same treatment.
      api.init.mockResolvedValue();
      api.downloadBudget.mockRejectedValueOnce(refused()).mockResolvedValue();

      await expect(syncWithoutWaiting()).resolves.toHaveLength(1);

      expect(api.downloadBudget).toHaveBeenCalledTimes(2);
      expect(api.init).toHaveBeenCalledTimes(2);
    });

    it('does not let a failed close become the error the run reports', async () => {
      // closeQuietly runs between retry attempts as well as in the `finally`, so a
      // shutdown that throws would otherwise turn a recoverable transient failure into a
      // hard one — and on the success path it would discard balances already read.
      api.init.mockRejectedValueOnce(refused()).mockResolvedValue();
      api.shutdown.mockRejectedValue(new Error('handle already closed'));

      await expect(syncWithoutWaiting()).resolves.toEqual([{ name: 'Checking', balance: 100012 }]);
    });

    it('gives up after MAX_RETRIES and reports the failure it was retrying', async () => {
      api.init.mockRejectedValue(refused());

      await expect(syncWithoutWaiting()).rejects.toThrow(/ECONNREFUSED/);

      expect(api.init).toHaveBeenCalledTimes(constants.MAX_RETRIES + 1);
      expect(api.getAccounts).not.toHaveBeenCalled();
    });
  });

  // One unreadable account used to cost every account its sync: the balances were read
  // with Promise.all, so a single rejection took the whole run down before anything was
  // written. This is the same "fail that account, sync the rest" rule the write side has.
  describe('getAccountBalances per-account failures', () => {
    beforeEach(() => {
      api.init.mockResolvedValue();
      api.downloadBudget.mockResolvedValue();
      api.shutdown.mockResolvedValue();

      const logger = require('../src/logger');
      jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    it('skips an account whose balance cannot be read and keeps the rest', async () => {
      // What a closed or off-budget account looks like: present in the account list,
      // no balance behind it.
      api.getAccounts.mockResolvedValue([
        { id: '1', name: 'Checking' },
        { id: '2', name: 'Closed' },
        { id: '3', name: 'Savings' },
      ]);
      api.getAccountBalance.mockImplementation(async (id) => (id === '2' ? null : 100012));

      await expect(actualBudget.getAccountBalances()).resolves.toEqual([
        { name: 'Checking', balance: 100012 },
        { name: 'Savings', balance: 100012 },
      ]);
    });

    it('skips an account whose balance is an impossible magnitude', async () => {
      // A corrupted read rather than a balance, and it must not reach Ghostfolio — but
      // it also must not stop the accounts that read correctly.
      api.getAccounts.mockResolvedValue([
        { id: '1', name: 'Checking' },
        { id: '2', name: 'Corrupt' },
      ]);
      api.getAccountBalance.mockImplementation(async (id) =>
        id === '2' ? constants.MAX_BALANCE_MINOR_UNITS * 10 : 100012
      );

      await expect(actualBudget.getAccountBalances()).resolves.toEqual([
        { name: 'Checking', balance: 100012 },
      ]);
    });

    it('skips an account whose name is not usable without reading its balance', async () => {
      api.getAccounts.mockResolvedValue([
        { id: '1', name: '   ' },
        { id: '2', name: 'Savings' },
      ]);
      api.getAccountBalance.mockResolvedValue(100012);

      await expect(actualBudget.getAccountBalances()).resolves.toEqual([
        { name: 'Savings', balance: 100012 },
      ]);

      expect(api.getAccountBalance).toHaveBeenCalledTimes(1);
      expect(api.getAccountBalance).toHaveBeenCalledWith('2');
    });

    it('does not log the name of an account whose name failed validation', async () => {
      // The rejected value is exactly the one that should not reach a log file, and a
      // log file on a mounted volume outlives the process.
      const logger = require('../src/logger');
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      api.getAccounts.mockResolvedValue([{ id: '1', name: '<script>alert(1)</script>' }]);
      api.getAccountBalance.mockResolvedValue(100012);

      await actualBudget.getAccountBalances();

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toMatch(/script/i);
    });

    it('returns nothing when no account could be read, rather than a partial truth', async () => {
      // index.js turns an empty list into a failed run. What must not happen is a
      // successful-looking sync over an empty set.
      api.getAccounts.mockResolvedValue([
        { id: '1', name: 'Checking' },
        { id: '2', name: 'Savings' },
      ]);
      api.getAccountBalance.mockResolvedValue(undefined);

      await expect(actualBudget.getAccountBalances()).resolves.toEqual([]);
    });
  });
});
