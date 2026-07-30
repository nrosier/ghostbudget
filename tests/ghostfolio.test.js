const nock = require('nock');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('ghostfolio', () => {
  let ghostfolio;
  const baseUrl = 'http://localhost:3333';

  beforeEach(() => {
    // Clear all mocks and reset modules
    jest.resetModules();
    nock.cleanAll();

    // Set up environment - add all required variables
    process.env.GHOSTFOLIO_URL = baseUrl;
    process.env.GHOSTFOLIO_TOKEN = 'test-token';
    process.env.ACTUAL_BUDGET_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_PASS = 'test-pass';
    process.env.ACTUAL_BUDGET_SYNC_ID = 'test-sync-id';
    process.env.ACTUAL_BUDGET_DATA_DIR = '/test/dir';
    process.env.NODE_ENV = 'test';

    // Import the module
    ghostfolio = require('../src/ghostfolio');

    // Directly set the configPath on the instance
    ghostfolio.configPath = path.join(__dirname, '..', 'config.json.example');

    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    nock.cleanAll();
    jest.clearAllMocks();
  });

  describe('syncAccountBalances', () => {
    const actualBalances = [
      {
        name: 'Main Savings',
        balance: 100012,
      },
      {
        name: 'Brokerage Account',
        balance: 100084,
      },
    ];

    it('should sync balances successfully', async () => {
      // Auth request
      nock(baseUrl)
        .post('/api/v1/auth/anonymous', {
          accessToken: 'test-token',
        })
        .reply(200, { authToken: 'test-token' });

      // Get accounts request
      nock(baseUrl)
        .get('/api/v1/account')
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, {
          accounts: [
            {
              id: '123',
              name: 'Savings Account',
              currency: 'USD',
              comment: null,
              isExcluded: false,
              platformId: 'platform-123',
            },
            {
              id: '321',
              name: 'Investment Account',
              currency: 'USD',
              comment: null,
              isExcluded: false,
              platformId: 'platform-123',
            },
          ],
        });

      // Update balance request
      nock(baseUrl)
        .put('/api/v1/account/123', (body) => {
          expect(body.balance).toBe(1000.12);
          return true;
        })
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, { success: true });
      nock(baseUrl)
        .put('/api/v1/account/321', (body) => {
          expect(body.balance).toBe(1000.84);
          return true;
        })
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, { success: true });

      await ghostfolio.syncAccountBalances(actualBalances);
    });

    it('should not fail completely when a single account cannot sync', async () => {
      // Auth request
      nock(baseUrl)
        .post('/api/v1/auth/anonymous', {
          accessToken: 'test-token',
        })
        .reply(200, { authToken: 'test-token' });

      // Get accounts request
      nock(baseUrl)
        .get('/api/v1/account')
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, {
          accounts: [
            {
              id: '123',
              name: 'Savings Account',
              currency: 'USD',
              comment: null,
              isExcluded: false,
              platformId: 'platform-123',
            },
            {
              id: '321',
              name: 'Investment Account',
              currency: 'USD',
              comment: null,
              isExcluded: false,
              platformId: 'platform-123',
            },
          ],
        });

      // Update balance request. Use a non-retryable 400 so the failure is
      // deterministic (a 500 on an idempotent PUT would be retried).
      nock(baseUrl)
        .put('/api/v1/account/123', (body) => {
          expect(body.balance).toBe(1000.12);
          return true;
        })
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(400, { success: false });
      nock(baseUrl)
        .put('/api/v1/account/321', (body) => {
          expect(body.balance).toBe(1000.84);
          return true;
        })
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, { success: true });

      await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
        /Failed to sync 1 account\(s\)/
      );
    });

    it('should match account names containing special characters', async () => {
      // Regression test for account matching: names with characters such as &
      // must match the values returned by the Ghostfolio API verbatim and must
      // not be HTML-escaped during validation.
      const specialConfigPath = path.join(os.tmpdir(), 'ghostbudget-special-config.json');
      fs.writeFileSync(
        specialConfigPath,
        JSON.stringify({
          accounts: [{ ghostfolioName: 'AT&T Stock', actualBudgetName: 'AT&T Stock' }],
        })
      );
      ghostfolio.configPath = specialConfigPath;

      try {
        nock(baseUrl)
          .post('/api/v1/auth/anonymous', { accessToken: 'test-token' })
          .reply(200, { authToken: 'test-token' });

        nock(baseUrl)
          .get('/api/v1/account')
          .matchHeader('Authorization', 'Bearer test-token')
          .reply(200, {
            accounts: [
              {
                id: '999',
                name: 'AT&T Stock',
                currency: 'USD',
                comment: null,
                isExcluded: false,
                platformId: null,
              },
            ],
          });

        nock(baseUrl)
          .put('/api/v1/account/999', (body) => {
            expect(body.name).toBe('AT&T Stock');
            expect(body.balance).toBe(1000.12);
            return true;
          })
          .matchHeader('Authorization', 'Bearer test-token')
          .reply(200, { success: true });

        await ghostfolio.syncAccountBalances([{ name: 'AT&T Stock', balance: 100012 }]);

        // If matching had failed, the PUT interceptor would remain unconsumed.
        expect(nock.isDone()).toBe(true);
      } finally {
        fs.unlinkSync(specialConfigPath);
      }
    });
  });

  describe('authenticate', () => {
    it('should authenticate successfully', async () => {
      nock(baseUrl)
        .post('/api/v1/auth/anonymous', {
          accessToken: 'test-token',
        })
        .reply(200, { authToken: 'received-token' });

      await ghostfolio.authenticate();
      expect(ghostfolio.accessToken).toBe('received-token');
    });

    it('should throw error when token is missing', async () => {
      delete process.env.GHOSTFOLIO_TOKEN;
      await expect(ghostfolio.authenticate()).rejects.toThrow(/GHOSTFOLIO_TOKEN/);
    });
  });

  describe('getGhostfolioAccounts', () => {
    beforeEach(() => {
      ghostfolio.accessToken = 'test-token';
    });

    it('should fetch accounts successfully', async () => {
      const mockResponse = {
        accounts: [
          {
            id: '123',
            name: 'Test Account',
            balance: 1000,
          },
        ],
      };

      nock(baseUrl)
        .get('/api/v1/account')
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, mockResponse);

      const accounts = await ghostfolio.getGhostfolioAccounts();
      expect(accounts).toEqual(mockResponse.accounts);
    });

    it('should throw when not authenticated', async () => {
      ghostfolio.accessToken = null;
      await expect(ghostfolio.getGhostfolioAccounts()).rejects.toThrow('Not authenticated');
    });
  });

  describe('updateAccountBalance', () => {
    const mockAccount = {
      id: '123',
      name: 'Test Account',
      currency: 'USD',
      comment: null,
      isExcluded: false,
      platformId: 'platform-123',
    };

    beforeEach(() => {
      ghostfolio.accessToken = 'test-token';
    });

    it('should update balance with correct conversion', async () => {
      nock(baseUrl)
        .put('/api/v1/account/123', (body) => {
          expect(body.balance).toBe(1000.12);
          return true;
        })
        .matchHeader('Authorization', 'Bearer test-token')
        .reply(200, { success: true });

      await ghostfolio.updateAccountBalance(mockAccount, 100012);
    });
  });
});
