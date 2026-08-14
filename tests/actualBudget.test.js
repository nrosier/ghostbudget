const api = require('@actual-app/api');

const { applyTestEnv } = require('./helpers/env');

// Mock the actual-api module
jest.mock('@actual-app/api');

describe('actualBudget', () => {
  let actualBudget;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    applyTestEnv();

    // Import the module in each test to get a fresh instance
    actualBudget = require('../src/actualBudget');
  });

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

      const logger = require('../src/logger');
      const error = jest.spyOn(logger, 'error').mockImplementation(() => {});

      await expect(actualBudget.getAccountBalances()).rejects.toThrow(/Could not get remote files/);

      expect(error).toHaveBeenCalledWith(expect.stringMatching(/Verify server URL, sync ID/));
    });
  });
});
