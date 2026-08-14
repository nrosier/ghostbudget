const nock = require('nock');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('ghostfolio', () => {
  let ghostfolio;
  const baseUrl = 'http://localhost:3333';

  // GHOSTFOLIO_TOKEN is Ghostfolio's anonymous-user security token, which is a
  // UUID; validateEnvironment enforces a 16-character minimum, so the fixture has
  // to be one. The two tokens are deliberately different values: the access token
  // is exchanged for a short-lived auth token, and a shared fixture would let a
  // test pass while the code sent the wrong one of the two.
  const accessToken = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
  const authToken = 'test-auth-token';

  beforeEach(() => {
    // Clear all mocks and reset modules
    jest.resetModules();
    nock.cleanAll();

    // Set up environment - add all required variables
    process.env.GHOSTFOLIO_URL = baseUrl;
    process.env.GHOSTFOLIO_TOKEN = accessToken;
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
          accessToken,
        })
        .reply(200, { authToken });

      // Get accounts request
      nock(baseUrl)
        .get('/api/v1/account')
        .matchHeader('Authorization', `Bearer ${authToken}`)
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
        .matchHeader('Authorization', `Bearer ${authToken}`)
        .reply(200, { success: true });
      nock(baseUrl)
        .put('/api/v1/account/321', (body) => {
          expect(body.balance).toBe(1000.84);
          return true;
        })
        .matchHeader('Authorization', `Bearer ${authToken}`)
        .reply(200, { success: true });

      await ghostfolio.syncAccountBalances(actualBalances);
    });

    it('should not fail completely when a single account cannot sync', async () => {
      // Auth request
      nock(baseUrl)
        .post('/api/v1/auth/anonymous', {
          accessToken,
        })
        .reply(200, { authToken });

      // Get accounts request
      nock(baseUrl)
        .get('/api/v1/account')
        .matchHeader('Authorization', `Bearer ${authToken}`)
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
        .matchHeader('Authorization', `Bearer ${authToken}`)
        .reply(400, { success: false });
      nock(baseUrl)
        .put('/api/v1/account/321', (body) => {
          expect(body.balance).toBe(1000.84);
          return true;
        })
        .matchHeader('Authorization', `Bearer ${authToken}`)
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
        nock(baseUrl).post('/api/v1/auth/anonymous', { accessToken }).reply(200, { authToken });

        nock(baseUrl)
          .get('/api/v1/account')
          .matchHeader('Authorization', `Bearer ${authToken}`)
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
          .matchHeader('Authorization', `Bearer ${authToken}`)
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
          accessToken,
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
      ghostfolio.accessToken = authToken;
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
        .matchHeader('Authorization', `Bearer ${authToken}`)
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
      ghostfolio.accessToken = authToken;
    });

    it('should update balance with correct conversion', async () => {
      nock(baseUrl)
        .put('/api/v1/account/123', (body) => {
          expect(body.balance).toBe(1000.12);
          return true;
        })
        .matchHeader('Authorization', `Bearer ${authToken}`)
        .reply(200, { success: true });

      await ghostfolio.updateAccountBalance(mockAccount, 100012);
    });

    /**
     * Capture the body of the single PUT this suite expects.
     *
     * @param {string} id - Account id in the request path
     * @returns {Function} A getter for the captured body
     */
    function capturePut(id) {
      let captured;
      nock(baseUrl)
        .put(`/api/v1/account/${id}`, (body) => {
          captured = body;
          return true;
        })
        .reply(200, { success: true });
      return () => captured;
    }

    it('rounds in minor units so a factor cannot produce a float artefact', async () => {
      // 100012 * 1.1 / 100 is 1100.1320000000001 in IEEE 754. That value used to be
      // sent verbatim to a financial API and stored as the account's balance.
      const body = capturePut('123');

      await ghostfolio.updateAccountBalance(mockAccount, 100012, 1.1);

      expect(body().balance).toBe(1100.13);
    });

    it('converts cents to units for the default factor', async () => {
      const body = capturePut('123');

      await ghostfolio.updateAccountBalance(mockAccount, -2550);

      expect(body().balance).toBe(-25.5);
    });

    it('sends only fields Ghostfolio’s UpdateAccountDto accepts', async () => {
      // Ghostfolio's NestJS validation pipe runs with forbidNonWhitelisted: true, so
      // one property outside the DTO fails the whole request with a 400. isExcluded
      // is not in the DTO — it was in the old hand-built payload — and tags must be
      // omitted because the GET returns objects while the DTO wants ids, and the
      // update implements tags as delete-all-then-create.
      const fetched = {
        ...mockAccount,
        isExcluded: false,
        tags: [{ id: 'tag-1', name: 'Retirement' }],
        value: 4321,
        valueInBaseCurrency: 4321,
        transactionCount: 12,
        Platform: { id: 'platform-123', name: 'Broker' },
      };
      const body = capturePut('123');

      await ghostfolio.updateAccountBalance(fetched, 100012);

      expect(Object.keys(body()).sort()).toEqual([
        'balance',
        'comment',
        'currency',
        'id',
        'name',
        'platformId',
      ]);
    });

    it('carries the existing field values through rather than resetting them', async () => {
      // A PUT that omits a field is a reset, not a no-op.
      const fetched = { ...mockAccount, comment: 'managed by ghostbudget', currency: 'EUR' };
      const body = capturePut('123');

      await ghostfolio.updateAccountBalance(fetched, 100012);

      expect(body()).toMatchObject({
        id: '123',
        name: 'Test Account',
        currency: 'EUR',
        comment: 'managed by ghostbudget',
        platformId: 'platform-123',
      });
    });

    it('sends platformId as null when the account has no platform', async () => {
      // platformId is the one DTO field required to be present while allowing null.
      const body = capturePut('123');

      await ghostfolio.updateAccountBalance({ ...mockAccount, platformId: undefined }, 100012);

      expect(body().platformId).toBeNull();
      expect('platformId' in body()).toBe(true);
    });

    it('audits whether the balance actually changed', async () => {
      const AuditLogger = require('../src/utils/audit');
      const logBalanceUpdate = jest.spyOn(AuditLogger, 'logBalanceUpdate');

      // Same value as the incoming balance: a no-op write, and the audit trail has
      // to say so. This used to be a hardcoded `true` for every account, every run.
      capturePut('123');
      await ghostfolio.updateAccountBalance({ ...mockAccount, balance: 1000.12 }, 100012);
      expect(logBalanceUpdate).toHaveBeenLastCalledWith(
        'Test Account',
        false,
        expect.objectContaining({ service: 'ghostfolio' })
      );

      capturePut('123');
      await ghostfolio.updateAccountBalance({ ...mockAccount, balance: 1.0 }, 100012);
      expect(logBalanceUpdate).toHaveBeenLastCalledWith(
        'Test Account',
        true,
        expect.objectContaining({ service: 'ghostfolio' })
      );
    });

    it('treats a missing previous balance as a change', async () => {
      const AuditLogger = require('../src/utils/audit');
      const logBalanceUpdate = jest.spyOn(AuditLogger, 'logBalanceUpdate');

      capturePut('123');
      await ghostfolio.updateAccountBalance(mockAccount, 100012);

      expect(logBalanceUpdate).toHaveBeenLastCalledWith('Test Account', true, expect.any(Object));
    });

    it('rejects a factor that would zero or invert every balance', async () => {
      // The Joi config schema applies positive(), so this gap only affected direct
      // callers of the public method — exactly the boundary it has to defend.
      for (const factor of [0, -1]) {
        await expect(ghostfolio.updateAccountBalance(mockAccount, 100012, factor)).rejects.toThrow(
          /Invalid factor/
        );
      }
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it('rejects a non-finite balance before any request is made', async () => {
      await expect(ghostfolio.updateAccountBalance(mockAccount, NaN)).rejects.toThrow(
        /Invalid balance/
      );
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it('throws when not authenticated', async () => {
      ghostfolio.accessToken = null;

      await expect(ghostfolio.updateAccountBalance(mockAccount, 100012)).rejects.toThrow(
        'Not authenticated'
      );
    });
  });
});
