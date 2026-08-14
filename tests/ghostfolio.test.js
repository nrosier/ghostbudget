const nock = require('nock');
const path = require('path');
const fs = require('fs');
const os = require('os');

let configFixtureCount = 0;

/**
 * Write a temporary config.json and point the client at it.
 *
 * Most cases here are about how a particular set of mappings is handled, so the
 * mappings are the fixture. `currency` is required by the schema, so it is defaulted
 * to EUR to match the Ghostfolio account fixtures below.
 *
 * @param {Object} ghostfolioInstance - The client under test
 * @param {Array<Object>} accounts - Mappings, each defaulted to currency EUR
 * @returns {Function} Removes the temporary file
 */
function withConfig(ghostfolioInstance, accounts) {
  configFixtureCount += 1;
  const configPath = path.join(
    os.tmpdir(),
    `ghostbudget-test-config-${process.pid}-${configFixtureCount}.json`
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      accounts: accounts.map((account) => ({ currency: 'EUR', ...account })),
    })
  );
  ghostfolioInstance.configPath = configPath;

  return () => fs.rmSync(configPath, { force: true });
}

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
    // Aligned with config.json.example, which is the config the first cases below
    // use: an example that no longer satisfies the schema is a broken first run.
    const actualBalances = [
      { name: 'Main Savings', balance: 100012 },
      { name: 'Checking', balance: 100084 },
    ];

    const ghostfolioAccounts = [
      {
        id: '123',
        name: 'Savings Account',
        currency: 'EUR',
        comment: null,
        isExcluded: false,
        platformId: 'platform-123',
      },
      {
        id: '321',
        name: 'Current Account',
        currency: 'EUR',
        comment: null,
        isExcluded: false,
        platformId: 'platform-123',
      },
    ];

    /**
     * Stub authentication and the account list.
     *
     * @param {Array<Object>} [accounts] - Accounts the list endpoint returns
     */
    function stubAuthAndAccounts(accounts = ghostfolioAccounts) {
      nock(baseUrl).post('/api/v1/auth/anonymous', { accessToken }).reply(200, { authToken });
      nock(baseUrl)
        .get('/api/v1/account')
        .matchHeader('Authorization', `Bearer ${authToken}`)
        .reply(200, { accounts });
    }

    /**
     * Stub a balance update that echoes back what it was sent, as Ghostfolio does.
     *
     * @param {string} id - Account id
     * @param {number} expectedBalance - Balance the request must carry
     */
    function stubUpdate(id, expectedBalance) {
      nock(baseUrl)
        .put(`/api/v1/account/${id}`, (body) => {
          expect(body.balance).toBe(expectedBalance);
          return true;
        })
        .matchHeader('Authorization', `Bearer ${authToken}`)
        .reply(200, (uri, body) => ({ id, balance: body.balance }));
    }

    it('should sync balances successfully', async () => {
      stubAuthAndAccounts();
      stubUpdate('123', 1000.12);
      stubUpdate('321', 1000.84);

      await ghostfolio.syncAccountBalances(actualBalances);

      expect(nock.isDone()).toBe(true);
    });

    it('should not fail completely when a single account cannot sync', async () => {
      stubAuthAndAccounts();

      // A non-retryable 400 so the failure is deterministic; axios-retry would
      // retry a 500 on an idempotent PUT.
      nock(baseUrl).put('/api/v1/account/123').reply(400, { success: false });
      stubUpdate('321', 1000.84);

      await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
        /Failed to sync 1 account\(s\)/
      );

      // The second account was still written: one bad mapping does not cost the
      // others their sync.
      expect(nock.isDone()).toBe(true);
    });

    it('attempts every account and reports each real error when many fail', async () => {
      // Regression test for the circuit breaker that used to wrap this client. It
      // opened at a 50% error rate over the shared request stream, so on a run like
      // this one — auth and the account fetch succeed, then the PUTs fail — the
      // third failure opened it and every account after that was rejected locally
      // with "Breaker is open": never sent, and its real error replaced in both the
      // summary and the audit trail. Four stale mappings became a wall.
      const names = ['Acct A', 'Acct B', 'Acct C', 'Acct D'];
      const cleanup = withConfig(
        ghostfolio,
        names.map((name) => ({ ghostfolioName: name, actualBudgetName: name }))
      );

      try {
        stubAuthAndAccounts(
          names.map((name, i) => ({
            id: `id-${i}`,
            name,
            currency: 'EUR',
            comment: null,
            platformId: null,
          }))
        );

        // 400 rather than 500: axios-retry does not retry it, so each account is
        // exactly one deterministic failure.
        for (let i = 0; i < names.length; i += 1) {
          nock(baseUrl).put(`/api/v1/account/id-${i}`).reply(400, { success: false });
        }

        const error = await ghostfolio
          .syncAccountBalances(names.map((name) => ({ name, balance: 100012 })))
          .then(() => null)
          .catch((err) => err);

        expect(error.message).toMatch(/Failed to sync 4 account\(s\)/);
        expect(error.message).not.toMatch(/Breaker is open/i);
        expect(error.message.match(/status code 400/g)).toHaveLength(4);
        // Every PUT was actually sent — an unconsumed interceptor means an account
        // was skipped rather than attempted and refused.
        expect(nock.isDone()).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('should match account names containing special characters', async () => {
      // Regression test for account matching: names with characters such as &
      // must match the values returned by the Ghostfolio API verbatim and must
      // not be HTML-escaped during validation.
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'AT&T Stock', actualBudgetName: 'AT&T Stock' },
      ]);

      try {
        stubAuthAndAccounts([
          { id: '999', name: 'AT&T Stock', currency: 'EUR', comment: null, platformId: null },
        ]);
        nock(baseUrl)
          .put('/api/v1/account/999', (body) => {
            expect(body.name).toBe('AT&T Stock');
            expect(body.balance).toBe(1000.12);
            return true;
          })
          .reply(200, { balance: 1000.12 });

        await ghostfolio.syncAccountBalances([{ name: 'AT&T Stock', balance: 100012 }]);

        // If matching had failed, the PUT interceptor would remain unconsumed.
        expect(nock.isDone()).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('writes nothing at all when every mapped account reports a zero balance', async () => {
      // The failure this whole two-phase structure exists for. A zero passes every
      // per-value guard — an emptied account really does hold nothing — so a budget
      // that downloaded without applying its sync messages, or a wrong
      // ACTUAL_BUDGET_SYNC_ID pointing at an empty budget, used to overwrite real
      // Ghostfolio balances with zeros and report the run as a success.
      stubAuthAndAccounts();
      const wouldBeWritten = nock(baseUrl)
        .put(/\/api\/v1\/account\/\d+/)
        .reply(200, {});

      await expect(
        ghostfolio.syncAccountBalances([
          { name: 'Main Savings', balance: 0 },
          { name: 'Checking', balance: 0 },
        ])
      ).rejects.toThrow(/all 2 resolved account\(s\) report a zero balance/);

      // Not one request was sent, which is the point: the check runs after every
      // mapping is resolved and before the first write.
      expect(wouldBeWritten.isDone()).toBe(false);
    });

    it('writes a single zero balance, because an emptied account is a real balance', async () => {
      stubAuthAndAccounts();
      stubUpdate('123', 0);
      stubUpdate('321', 1000.84);

      await ghostfolio.syncAccountBalances([
        { name: 'Main Savings', balance: 0 },
        { name: 'Checking', balance: 100084 },
      ]);

      expect(nock.isDone()).toBe(true);
    });

    it('refuses an ambiguous Ghostfolio name rather than writing to the first match', async () => {
      // Ghostfolio does not enforce unique account names. `find()` took the first
      // match, so the balance went to whichever account the API happened to list
      // first, the other was never touched, and the run reported success.
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'Savings', actualBudgetName: 'Main Savings' },
      ]);

      try {
        stubAuthAndAccounts([
          { id: 'first', name: 'Savings', currency: 'EUR', comment: null, platformId: null },
          { id: 'second', name: 'Savings', currency: 'EUR', comment: null, platformId: null },
        ]);
        const first = nock(baseUrl).put('/api/v1/account/first').reply(200, {});
        const second = nock(baseUrl).put('/api/v1/account/second').reply(200, {});

        await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
          /Ambiguous mapping: 2 Ghostfolio accounts are named Savings/
        );

        expect(first.isDone()).toBe(false);
        expect(second.isDone()).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('refuses an ambiguous Actual Budget name', async () => {
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'Savings Account', actualBudgetName: 'Main Savings' },
      ]);

      try {
        stubAuthAndAccounts();

        await expect(
          ghostfolio.syncAccountBalances([
            { name: 'Main Savings', balance: 100012 },
            { name: 'Main Savings', balance: 4242 },
          ])
        ).rejects.toThrow(/Ambiguous mapping: 2 Actual Budget accounts are named Main Savings/);
      } finally {
        cleanup();
      }
    });

    it('refuses a currency mismatch and still syncs the accounts that agree', async () => {
      // Nothing in either API says which currency an Actual Budget balance is in, so
      // a EUR balance used to be written verbatim into a USD account and simply read
      // as the wrong amount of money from then on.
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'Savings Account', actualBudgetName: 'Main Savings', currency: 'USD' },
        { ghostfolioName: 'Current Account', actualBudgetName: 'Checking', currency: 'EUR' },
      ]);

      try {
        stubAuthAndAccounts();
        const mismatched = nock(baseUrl).put('/api/v1/account/123').reply(200, {});
        stubUpdate('321', 1000.84);

        await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
          /Currency mismatch for account Savings Account: config.json declares USD, the Ghostfolio account is denominated in EUR/
        );

        expect(mismatched.isDone()).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('reports a Ghostfolio account with no currency set rather than guessing', async () => {
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'Savings Account', actualBudgetName: 'Main Savings' },
      ]);

      try {
        stubAuthAndAccounts([
          { id: '123', name: 'Savings Account', comment: null, platformId: null },
        ]);

        await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
          /denominated in \(unset\)/
        );
      } finally {
        cleanup();
      }
    });

    it('resolves every mapping and sends no write when DRY_RUN is set', async () => {
      process.env.DRY_RUN = 'true';
      try {
        jest.resetModules();
        const dryRun = require('../src/ghostfolio');
        dryRun.configPath = path.join(__dirname, '..', 'config.json.example');

        stubAuthAndAccounts();
        const wouldBeWritten = nock(baseUrl)
          .put(/\/api\/v1\/account\/\d+/)
          .reply(200, {});

        await expect(dryRun.syncAccountBalances(actualBalances)).resolves.toBeUndefined();

        expect(wouldBeWritten.isDone()).toBe(false);
      } finally {
        delete process.env.DRY_RUN;
      }
    });

    it('refuses a config in which two mappings target one Ghostfolio account', async () => {
      // The second PUT overwrites the first, so one of the two balances is silently
      // discarded and the run still reports success. Caught before authenticating.
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'Savings Account', actualBudgetName: 'Main Savings' },
        { ghostfolioName: 'Savings Account', actualBudgetName: 'Checking' },
      ]);

      try {
        await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
          /Invalid configuration.*duplicate value/
        );
      } finally {
        cleanup();
      }
    });

    it('fails only the mapping whose account is missing on either side', async () => {
      // A renamed or deleted account is the ordinary way a mapping goes stale. It
      // must fail loudly and cost nothing else its sync — including the case where
      // the name is missing from Actual Budget rather than from Ghostfolio.
      const cleanup = withConfig(ghostfolio, [
        { ghostfolioName: 'Savings Account', actualBudgetName: 'Main Savings' },
        { ghostfolioName: 'Renamed In Ghostfolio', actualBudgetName: 'Checking' },
        { ghostfolioName: 'Current Account', actualBudgetName: 'Closed In Actual' },
      ]);

      try {
        stubAuthAndAccounts();
        stubUpdate('123', 1000.12);

        const error = await ghostfolio
          .syncAccountBalances(actualBalances)
          .then(() => null)
          .catch((err) => err);

        expect(error.message).toMatch(/Failed to sync 2 account\(s\)/);
        expect(error.message).toMatch(
          /No matching Ghostfolio account found for Renamed In Ghostfolio/
        );
        expect(error.message).toMatch(
          /No matching Actual Budget account found for Closed In Actual/
        );
        // The one mapping that did resolve was written.
        expect(nock.isDone()).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('sends nothing at all when the config file cannot be read or parsed', async () => {
      // Read before authenticating, so a local mistake does not exchange the security
      // token first. Neither request should be made, let alone a write.
      const wouldBeReached = nock(baseUrl).post('/api/v1/auth/anonymous').reply(200, { authToken });

      ghostfolio.configPath = path.join(os.tmpdir(), 'ghostbudget-no-such-config.json');

      await expect(ghostfolio.syncAccountBalances(actualBalances)).rejects.toThrow(
        /Config file error/
      );
      expect(wouldBeReached.isDone()).toBe(false);
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

    it('refuses to construct the client at all when the token is missing', () => {
      // This used to assert that authenticate() rejected, which it did because
      // authenticate() re-ran the whole environment schema on every call — so the
      // test could delete the variable after the client already existed. The real
      // guarantee is the one README states: the process refuses to start rather
      // than starting with a configuration that cannot work.
      jest.resetModules();
      delete process.env.GHOSTFOLIO_TOKEN;

      expect(() => require('../src/ghostfolio')).toThrow(/GHOSTFOLIO_TOKEN/);
    });

    it('sends the security token from the environment, not the auth token', async () => {
      // The two are different values on purpose: the security token is exchanged
      // for a short-lived authToken, and sending the wrong one of the two is a
      // mistake a shared fixture would hide.
      nock(baseUrl)
        .post('/api/v1/auth/anonymous', { accessToken })
        .reply(200, { authToken: 'received-token' });

      await ghostfolio.authenticate();

      expect(nock.isDone()).toBe(true);
    });

    it('rejects an auth response whose authToken is absent, null or empty', async () => {
      // The presence check that fronted this (validateApiResponse) is gone, so the
      // stricter one that always followed it has to carry the case on its own —
      // including a null body, which would otherwise be a TypeError from here.
      for (const body of [{}, { authToken: null }, { authToken: '' }, { authToken: 42 }, null]) {
        nock.cleanAll();
        nock(baseUrl).post('/api/v1/auth/anonymous').reply(200, body);

        await expect(ghostfolio.authenticate()).rejects.toThrow(
          /missing or empty authToken|Invalid authentication response/
        );
      }
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

    it('rejects a body whose accounts field is missing, null or not an array', async () => {
      // One check does all of this now that validateApiResponse no longer fronts it:
      // `'accounts' in body` was satisfied by a string, and a null body would throw
      // a TypeError here without the optional chaining.
      for (const body of [{}, { accounts: null }, { accounts: 'two' }, null]) {
        nock.cleanAll();
        nock(baseUrl).get('/api/v1/account').reply(200, body);

        await expect(ghostfolio.getGhostfolioAccounts()).rejects.toThrow(
          /accounts must be an array/
        );
      }
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

    it('sends nothing when the balance already matches, and audits that it did not', async () => {
      const AuditLogger = require('../src/utils/audit');
      const logBalanceUpdate = jest.spyOn(AuditLogger, 'logBalanceUpdate');

      // Same value as the incoming balance. The PUT used to fire anyway — `changed`
      // only decided what the audit trail said about it — so a nightly run rewrote
      // every mapped balance every night, including the ones that had not moved.
      const wouldBeWritten = nock(baseUrl).put('/api/v1/account/123').reply(200, {});

      const result = await ghostfolio.updateAccountBalance(
        { ...mockAccount, balance: 1000.12 },
        100012
      );

      expect(wouldBeWritten.isDone()).toBe(false);
      expect(result).toBeNull();
      expect(logBalanceUpdate).toHaveBeenLastCalledWith('Test Account', false, {
        service: 'ghostfolio',
        written: false,
      });
    });

    it('writes and audits the write when the balance has moved', async () => {
      const AuditLogger = require('../src/utils/audit');
      const logBalanceUpdate = jest.spyOn(AuditLogger, 'logBalanceUpdate');

      nock(baseUrl)
        .put('/api/v1/account/123')
        .reply(200, (uri, body) => ({ ...mockAccount, balance: body.balance }));

      await ghostfolio.updateAccountBalance({ ...mockAccount, balance: 1.0 }, 100012);

      expect(logBalanceUpdate).toHaveBeenLastCalledWith('Test Account', true, {
        service: 'ghostfolio',
        written: true,
      });
    });

    it('fails the account when Ghostfolio echoes back a different balance', async () => {
      // A 2xx used to be the whole success criterion. The response carries the
      // account as it now stands, so the value actually stored is right there — and
      // if it is not the value that was sent, the run has not done its job however
      // cleanly the request completed.
      const AuditLogger = require('../src/utils/audit');
      const logBalanceUpdate = jest.spyOn(AuditLogger, 'logBalanceUpdate');

      nock(baseUrl)
        .put('/api/v1/account/123')
        .reply(200, { ...mockAccount, balance: 999.99 });

      await expect(ghostfolio.updateAccountBalance(mockAccount, 100012)).rejects.toThrow(
        /stored a different balance than was sent for account Test Account/
      );

      // Not audited as a successful write, and neither balance appears anywhere.
      expect(logBalanceUpdate).not.toHaveBeenCalledWith(
        'Test Account',
        true,
        expect.objectContaining({ written: true })
      );
    });

    it('keeps both balances out of the mismatch error', async () => {
      nock(baseUrl)
        .put('/api/v1/account/123')
        .reply(200, { ...mockAccount, balance: 8675.309 });

      const error = await ghostfolio.updateAccountBalance(mockAccount, 424242).catch((e) => e);

      expect(error.message).not.toContain('8675');
      expect(error.message).not.toContain('4242');
    });

    it('accepts a response that carries no balance to compare', async () => {
      // A Ghostfolio version answering with an empty body, or a proxy that strips it,
      // has not told us the write went wrong either. Unconfirmed is not failed — but
      // it must say so rather than imply the value was checked.
      const logger = require('../src/logger');
      const warn = jest.spyOn(logger, 'warn');

      nock(baseUrl).put('/api/v1/account/123').reply(200, { success: true });

      await expect(ghostfolio.updateAccountBalance(mockAccount, 100012)).resolves.toEqual({
        success: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/Could not confirm the stored balance/),
        expect.objectContaining({ account: 'Test Account' })
      );
    });

    it('refuses an account id carrying characters an id does not carry', async () => {
      // The id is interpolated into the request path. encodeURIComponent covers the
      // path itself; this covers the case where the value is not an id at all, and it
      // has to refuse before a request rather than send one somewhere unintended.
      const wouldBeWritten = nock(baseUrl).put(/.*/).reply(200, {});

      for (const id of ['../../api/v1/order', '123?admin=1', '', 'a'.repeat(65), 42]) {
        await expect(
          ghostfolio.updateAccountBalance({ ...mockAccount, id }, 100012)
        ).rejects.toThrow(/Ghostfolio account id/);
      }

      expect(wouldBeWritten.isDone()).toBe(false);
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
