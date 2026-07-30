const api = require('@actual-app/api');

// Mock the actual-api module
jest.mock('@actual-app/api');

describe('actualBudget', () => {
  let actualBudget;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Mock console to avoid noise in tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Set required environment variables. validateEnvironment() validates the
    // full application schema, so both Actual Budget and Ghostfolio vars must
    // be present for the environment to be considered valid.
    process.env.ACTUAL_BUDGET_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_PASS = 'test-pass';
    process.env.ACTUAL_BUDGET_SYNC_ID = 'test-sync-id';
    process.env.ACTUAL_BUDGET_DATA_DIR = '/test/dir';
    process.env.GHOSTFOLIO_URL = 'http://localhost:3333';
    process.env.GHOSTFOLIO_TOKEN = 'test-token';

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
  });
});
