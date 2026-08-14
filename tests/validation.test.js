const fs = require('fs');
const os = require('os');
const path = require('path');

const constants = require('../src/config/constants');
const {
  validateConfig,
  validateEnvironment,
  validateBalance,
  validateFactor,
  validateAccountName,
  validateAccountId,
  validateDataDir,
  isPrivateHost,
  errorMessageOf,
  redactSecrets,
  sanitizeError,
} = require('../src/utils/validation');

describe('validateDataDir', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the resolved path for a writable directory', () => {
    expect(validateDataDir(tempDir)).toBe(path.resolve(tempDir));
  });

  it('normalizes a path containing traversal segments', () => {
    const nested = path.join(tempDir, 'a', '..', 'b');
    fs.mkdirSync(path.join(tempDir, 'b'));

    expect(validateDataDir(nested)).toBe(path.join(tempDir, 'b'));
  });

  it('treats unset as unset rather than as an error', () => {
    // The variable is optional in the environment schema, so an empty value must
    // not be turned into a startup failure.
    expect(validateDataDir(undefined)).toBeUndefined();
    expect(validateDataDir(null)).toBeUndefined();
    expect(validateDataDir('')).toBeUndefined();
  });

  it('rejects system directories', () => {
    // The old entrypoint ran `chown -R` against this value as root, so "/" meant
    // recursively rewriting ownership of the container filesystem.
    for (const protectedDir of ['/', '/etc', '/usr', '/var', '/root', '/proc']) {
      expect(() => validateDataDir(protectedDir)).toThrow(/must not be a system directory/);
    }
  });

  it('rejects a relative path', () => {
    expect(() => validateDataDir('data')).toThrow(/must be an absolute path/);
    expect(() => validateDataDir('./data')).toThrow(/must be an absolute path/);
  });

  it('rejects a non-string value', () => {
    expect(() => validateDataDir(42)).toThrow(/must be a string/);
    expect(() => validateDataDir({})).toThrow(/must be a string/);
  });

  it('rejects a directory that does not exist', () => {
    // The old shell guard silently skipped when the path was missing, and Actual
    // Budget then wrote to a path that was never persisted.
    expect(() => validateDataDir(path.join(tempDir, 'absent'))).toThrow(/does not exist/);
  });

  it('rejects a path that is a file', () => {
    const file = path.join(tempDir, 'a-file');
    fs.writeFileSync(file, '');

    expect(() => validateDataDir(file)).toThrow(/is not a directory/);
  });

  it('rejects a directory it cannot write to', () => {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      // Root bypasses the permission bits, so there is nothing to assert.
      return;
    }

    const locked = path.join(tempDir, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });

    try {
      expect(() => validateDataDir(locked)).toThrow(/is not readable and writable/);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe('validateBalance', () => {
  it('accepts any finite number, including zero and negatives', () => {
    // An account can legitimately be empty or overdrawn.
    for (const value of [0, -1, 100012, -100012, 0.5]) {
      expect(validateBalance(value)).toBe(value);
    }
  });

  it('rejects non-finite and non-numeric values', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => validateBalance(value)).toThrow(/must be a finite number/);
    }
    for (const value of ['100', null, undefined, {}, []]) {
      expect(() => validateBalance(value)).toThrow(/must be a finite number/);
    }
  });

  it('rejects a magnitude no real balance reaches', () => {
    // A finite number was the only requirement, so a corrupted read of 1e20 was
    // written to Ghostfolio verbatim. This runs on the Actual Budget fetch too,
    // where Promise.all means one such value fails the whole read and nothing at
    // all is written.
    for (const value of [1e20, -1e20, constants.MAX_BALANCE_MINOR_UNITS + 1]) {
      expect(() => validateBalance(value)).toThrow(/magnitude exceeds/);
    }

    expect(validateBalance(constants.MAX_BALANCE_MINOR_UNITS)).toBe(
      constants.MAX_BALANCE_MINOR_UNITS
    );
  });

  it('keeps the offending balance out of its error message', () => {
    // These messages are logged and joined into the run summary. The message names
    // the limit, which is a constant; it must not name the value, which is money.
    let message = '';
    try {
      validateBalance(1.23456789e15);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/magnitude exceeds/);
    expect(message).not.toContain('1.23456789');
    expect(message).not.toContain('123456789');
  });
});

describe('validateFactor', () => {
  it('accepts a positive factor', () => {
    for (const value of [1, 0.01, 2.5, constants.MAX_BALANCE_FACTOR]) {
      expect(validateFactor(value)).toBe(value);
    }
  });

  it('rejects zero and negative factors', () => {
    // The reason this validator exists separately from validateBalance. Reusing
    // the balance rule here let `factor: 0` zero every balance and `factor: -1`
    // flip every sign, both of which then reached the Ghostfolio API.
    expect(() => validateFactor(0)).toThrow(/must be greater than zero/);
    expect(() => validateFactor(-1)).toThrow(/must be greater than zero/);
    expect(() => validateFactor(-0.5)).toThrow(/must be greater than zero/);
  });

  it('rejects an implausibly large factor', () => {
    expect(() => validateFactor(constants.MAX_BALANCE_FACTOR + 1)).toThrow(/must not exceed/);
  });

  it('rejects non-finite and non-numeric values', () => {
    for (const value of [NaN, Infinity, '2', null, undefined]) {
      expect(() => validateFactor(value)).toThrow(/must be a finite number/);
    }
  });
});

describe('validateAccountName', () => {
  it('trims and returns a valid name', () => {
    expect(validateAccountName('  Main Savings  ')).toBe('Main Savings');
  });

  it('preserves characters that must survive for account matching', () => {
    // Names are matched verbatim against both APIs and serialized as JSON, never
    // rendered as HTML, so escaping them here would break matching.
    for (const name of ['AT&T Stock', 'Réserve', "Nick's ISA", 'A <> B', '"Quoted"']) {
      expect(validateAccountName(name)).toBe(name);
    }
  });

  it('rejects empty, blank, and non-string names', () => {
    for (const name of ['', '   ', null, undefined, 42, {}]) {
      expect(() => validateAccountName(name)).toThrow(/non-empty string/);
    }
  });

  it('rejects a name longer than the configured maximum', () => {
    const long = 'a'.repeat(constants.MAX_ACCOUNT_NAME_LENGTH + 1);
    expect(() => validateAccountName(long)).toThrow(/must not exceed/);
    expect(validateAccountName('a'.repeat(constants.MAX_ACCOUNT_NAME_LENGTH))).toHaveLength(
      constants.MAX_ACCOUNT_NAME_LENGTH
    );
  });

  it('rejects obvious script-injection payloads', () => {
    for (const name of ['<script>alert(1)</script>', 'javascript:alert(1)', 'x onerror=alert(1)']) {
      expect(() => validateAccountName(name)).toThrow(/invalid characters/);
    }
  });
});

describe('validateEnvironment', () => {
  const validEnv = () => ({
    ACTUAL_BUDGET_URL: 'https://budget.example.com',
    ACTUAL_BUDGET_PASS: 'a-password',
    ACTUAL_BUDGET_SYNC_ID: 'sync-id',
    GHOSTFOLIO_URL: 'https://ghostfolio.example.com',
    GHOSTFOLIO_TOKEN: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
    NODE_ENV: 'test',
  });

  it('accepts a complete environment and applies defaults', () => {
    const value = validateEnvironment(validEnv());

    expect(value.LOG_LEVEL).toBe('info');
    expect(value.MAX_RETRIES).toBe(3);
  });

  it('reports every missing variable at once rather than the first', () => {
    // abortEarly: false — an operator setting up the container should see the
    // whole list, not discover them one restart at a time.
    expect(() => validateEnvironment({})).toThrow(/ACTUAL_BUDGET_URL/);
    expect(() => validateEnvironment({})).toThrow(/GHOSTFOLIO_TOKEN/);
  });

  it('enforces the credential minimum lengths', () => {
    // Both floors used to be 1, so they rejected only the empty string:
    // ACTUAL_BUDGET_PASS=x validated happily.
    const shortPass = { ...validEnv(), ACTUAL_BUDGET_PASS: 'a'.repeat(7) };
    expect(() => validateEnvironment(shortPass)).toThrow(/ACTUAL_BUDGET_PASS/);
    expect(constants.MIN_PASSWORD_LENGTH).toBe(8);

    const shortToken = { ...validEnv(), GHOSTFOLIO_TOKEN: 'a'.repeat(15) };
    expect(() => validateEnvironment(shortToken)).toThrow(/GHOSTFOLIO_TOKEN/);
    expect(constants.MIN_TOKEN_LENGTH).toBe(16);

    const atMinimum = {
      ...validEnv(),
      ACTUAL_BUDGET_PASS: 'a'.repeat(constants.MIN_PASSWORD_LENGTH),
      GHOSTFOLIO_TOKEN: 'a'.repeat(constants.MIN_TOKEN_LENGTH),
    };
    expect(() => validateEnvironment(atMinimum)).not.toThrow();
  });

  it('rejects a URL that is not http or https', () => {
    const env = { ...validEnv(), GHOSTFOLIO_URL: 'file:///etc/passwd' };
    expect(() => validateEnvironment(env)).toThrow(/GHOSTFOLIO_URL/);
  });

  it('refuses plaintext HTTP to a public host, in every environment', () => {
    // The rule used to apply only when NODE_ENV=production, which meant a developer
    // who had not set NODE_ENV sent the password and the token in the clear to
    // whatever remote host was configured. Both cases below are checked with
    // NODE_ENV unset.
    const actual = { ...validEnv(), ACTUAL_BUDGET_URL: 'http://budget.example.com' };
    expect(() => validateEnvironment(actual)).toThrow(/ACTUAL_BUDGET_URL must use https/);

    const ghostfolio = { ...validEnv(), GHOSTFOLIO_URL: 'http://ghostfolio.example.com' };
    expect(() => validateEnvironment(ghostfolio)).toThrow(/GHOSTFOLIO_URL must use https/);

    // A public IP literal is not a private host either.
    const publicIp = { ...validEnv(), GHOSTFOLIO_URL: 'http://93.184.216.34:3333' };
    expect(() => validateEnvironment(publicIp)).toThrow(/must use https/);
  });

  it('records a security event when a credential would cross the network in the clear', () => {
    const AuditLogger = require('../src/utils/audit');
    const logSecurityEvent = jest.spyOn(AuditLogger, 'logSecurityEvent').mockImplementation();

    try {
      expect(() =>
        validateEnvironment({ ...validEnv(), GHOSTFOLIO_URL: 'http://ghostfolio.example.com' })
      ).toThrow();

      expect(logSecurityEvent).toHaveBeenCalledWith('insecure_transport', 'high', {
        variable: 'GHOSTFOLIO_URL',
      });
    } finally {
      logSecurityEvent.mockRestore();
    }
  });

  it('allows plaintext HTTP to a host only a local network can reach', () => {
    // Including NODE_ENV=production, which is what the image sets. The old rule made
    // the deployment this project recommends impossible to start: a compose file
    // reaching Ghostfolio at its service name over the container network was
    // rejected, and so was .env.example as shipped.
    const hosts = [
      'http://localhost:5006',
      'http://127.0.0.1:3333',
      'http://actual_server:5006', // Docker Compose service name
      'http://ghostfolio', // single-label host
      'http://10.1.2.3:3333',
      'http://172.20.0.5:3333',
      'http://192.168.1.50:3333',
      'http://169.254.10.10:3333', // link-local
      'http://budget.local:5006', // mDNS
      'http://ghostfolio.internal:3333',
      'http://[::1]:3333',
      'http://[fd00::1]:3333', // IPv6 unique-local
      'http://[fe80::1]:3333', // IPv6 link-local
      'https://budget.example.com', // HTTPS anywhere, always
    ];

    for (const url of hosts) {
      const env = { ...validEnv(), NODE_ENV: 'production', GHOSTFOLIO_URL: url };
      expect(() => validateEnvironment(env)).not.toThrow();
    }
  });

  it('classifies hosts without being reached through the schema', () => {
    // isPrivateHost is exported so the boundary cases can be stated directly rather
    // than inferred from which URLs happen to be accepted.
    expect(isPrivateHost('172.15.0.1')).toBe(false); // just below the RFC 1918 range
    expect(isPrivateHost('172.32.0.1')).toBe(false); // just above it
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.254')).toBe(true);
    expect(isPrivateHost('11.0.0.1')).toBe(false);
    expect(isPrivateHost('192.169.1.1')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('LOCALHOST')).toBe(true);
    expect(isPrivateHost('app.localhost')).toBe(true);
    expect(isPrivateHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateHost('2606:4700::1111')).toBe(false);
  });

  it('rejects a URL string the schema accepts but URL() cannot parse', () => {
    // Joi's uri() and the WHATWG URL parser are not the same grammar: a port above
    // 65535 satisfies the first and fails the second. The transport check states its
    // own precondition rather than assuming the schema has established it, because
    // otherwise an unparseable URL would take the code path for a *secure* one.
    const env = { ...validEnv(), GHOSTFOLIO_URL: 'http://ghostfolio:99999' };

    expect(() => validateEnvironment(env)).toThrow('GHOSTFOLIO_URL is not a valid URL');
  });

  it('reads DRY_RUN as a boolean and defaults it to off', () => {
    // Environment variables are strings; a flag that decides whether anything is
    // written must not be true merely because 'false' is a non-empty string.
    expect(validateEnvironment(validEnv()).DRY_RUN).toBe(false);
    expect(validateEnvironment({ ...validEnv(), DRY_RUN: 'true' }).DRY_RUN).toBe(true);
    expect(validateEnvironment({ ...validEnv(), DRY_RUN: 'false' }).DRY_RUN).toBe(false);
    expect(() => validateEnvironment({ ...validEnv(), DRY_RUN: 'yes' })).toThrow(/DRY_RUN/);
  });

  it('ignores unknown variables instead of failing on them', () => {
    // CACHE_TTL_MINUTES was removed from the schema. An operator who still has it
    // in a .env file must not be greeted with a startup failure.
    const env = { ...validEnv(), CACHE_TTL_MINUTES: '5', SOMETHING_ELSE: 'x' };

    // The schema declares .unknown(true), so the value is carried through rather
    // than stripped. Nothing reads it — the cache it configured is gone — but the
    // container still starts.
    expect(() => validateEnvironment(env)).not.toThrow();
    expect(validateEnvironment(env).CACHE_TTL_MINUTES).toBe('5');
  });
});

describe('validateConfig', () => {
  const mapping = (extra = {}) => ({
    ghostfolioName: 'A',
    actualBudgetName: 'B',
    currency: 'EUR',
    ...extra,
  });

  it('accepts a valid mapping and defaults the factor to 1', () => {
    const value = validateConfig({ accounts: [mapping()] });

    expect(value.accounts[0].factor).toBe(1);
  });

  it('rejects a non-positive factor', () => {
    for (const factor of [0, -1]) {
      expect(() => validateConfig({ accounts: [mapping({ factor })] })).toThrow(
        /Invalid configuration/
      );
    }
  });

  it('rejects an empty or missing accounts array', () => {
    expect(() => validateConfig({ accounts: [] })).toThrow(/Invalid configuration/);
    expect(() => validateConfig({})).toThrow(/Invalid configuration/);
  });

  it('strips unknown keys rather than trusting them', () => {
    const value = validateConfig({
      accounts: [mapping({ injected: 'x' })],
      extra: true,
    });

    expect(value.accounts[0].injected).toBeUndefined();
    expect(value.extra).toBeUndefined();
  });

  it('requires a currency and says why in the message', () => {
    // Without a declared currency, a balance in one currency is written verbatim
    // into an account denominated in another: no error, just the wrong amount of
    // money from then on. Neither API reports the currency of an Actual Budget
    // balance, so the only place it can come from is the config.
    const withoutCurrency = mapping();
    delete withoutCurrency.currency;

    expect(() => validateConfig({ accounts: [withoutCurrency] })).toThrow(/"currency" is required/);
    expect(() => validateConfig({ accounts: [withoutCurrency] })).toThrow(/ISO 4217/);
  });

  it('normalizes a currency and rejects one that is not an ISO 4217 code', () => {
    expect(
      validateConfig({ accounts: [mapping({ currency: ' eur ' })] }).accounts[0].currency
    ).toBe('EUR');

    for (const currency of ['EURO', 'EU', '€', '123']) {
      expect(() => validateConfig({ accounts: [mapping({ currency })] })).toThrow(
        /Invalid configuration/
      );
    }
  });

  it('refuses two mappings that target one Ghostfolio account', () => {
    // These are not additive: each mapping is a full PUT of the account's balance,
    // so the second silently overwrites the first and the run reports success.
    expect(() =>
      validateConfig({
        accounts: [mapping({ actualBudgetName: 'Stocks' }), mapping({ actualBudgetName: 'Bonds' })],
      })
    ).toThrow(/duplicate value/);
  });

  it('sees through whitespace when checking for a duplicate target', () => {
    expect(() =>
      validateConfig({
        accounts: [
          mapping({ ghostfolioName: 'Savings', actualBudgetName: 'Stocks' }),
          mapping({ ghostfolioName: '  Savings  ', actualBudgetName: 'Bonds' }),
        ],
      })
    ).toThrow(/duplicate value/);
  });

  it('allows one Actual Budget account to feed two different Ghostfolio accounts', () => {
    // Unusual but not lossy: two distinct targets each get a write of their own.
    expect(() =>
      validateConfig({
        accounts: [mapping({ ghostfolioName: 'A' }), mapping({ ghostfolioName: 'B' })],
      })
    ).not.toThrow();
  });

  it('validates config.json.example as shipped', () => {
    // The example is what an operator copies, and a required field added to the
    // schema without being added there makes the documented first run fail.
    const example = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config.json.example'), 'utf8')
    );

    expect(() => validateConfig(example)).not.toThrow();
  });
});

describe('validateAccountId', () => {
  it('accepts the identifier shapes Ghostfolio issues', () => {
    for (const id of ['123', 'clx1a2b3c4d5e6f7g8h9', '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9']) {
      expect(validateAccountId(id)).toBe(id);
    }
  });

  it('refuses an id that would address a different endpoint', () => {
    // The id is interpolated into the request path. It comes from Ghostfolio's own
    // response, so this is defence in depth rather than a likely attack — but "the
    // server told us" is not a reason to build a URL out of a value.
    for (const id of ['../../auth/anonymous', 'abc?query=1', 'abc/def', 'a b']) {
      expect(() => validateAccountId(id)).toThrow(/unexpected characters/);
    }
  });

  it('refuses an absent, non-string or oversized id', () => {
    for (const id of [undefined, null, '', 42, {}]) {
      expect(() => validateAccountId(id)).toThrow(/non-empty string/);
    }

    expect(() => validateAccountId('a'.repeat(constants.MAX_ACCOUNT_ID_LENGTH + 1))).toThrow(
      /must not exceed/
    );
  });
});

describe('redactSecrets', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('replaces exact secret values read from the environment', () => {
    process.env.ACTUAL_BUDGET_PASS = 'sup3r-s3cret-value';
    process.env.GHOSTFOLIO_TOKEN = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

    const text = 'login failed for sup3r-s3cret-value using 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
    const result = redactSecrets(text);

    expect(result).not.toContain('sup3r-s3cret-value');
    expect(result).not.toContain('0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9');
    expect(result).toContain('[REDACTED:ACTUAL_BUDGET_PASS]');
    expect(result).toContain('[REDACTED:GHOSTFOLIO_TOKEN]');
  });

  it('replaces every occurrence of a secret, not just the first', () => {
    process.env.ACTUAL_BUDGET_PASS = 'repeated-secret';

    const result = redactSecrets('repeated-secret and repeated-secret again');

    expect(result).not.toContain('repeated-secret');
  });

  it('skips a secret too short to replace safely', () => {
    // Replacing a two-character value would shred the message without protecting
    // anything, and such a value fails validateEnvironment in the first place.
    process.env.ACTUAL_BUDGET_PASS = 'ab';

    expect(redactSecrets('a database problem')).toBe('a database problem');
  });

  it('redacts a bearer token minted at runtime', () => {
    // The Ghostfolio auth token is issued by the server and is in no environment
    // variable, so the exact-value pass cannot see it.
    const result = redactSecrets('Request failed: Authorization: Bearer eyJhbGciOi.J9.abc-123');

    expect(result).not.toContain('eyJhbGciOi.J9.abc-123');
    expect(result).toContain('Bearer [REDACTED]');
  });

  it('redacts credential-shaped key/value pairs while keeping the label', () => {
    const result = redactSecrets(
      'body: {"accessToken":"abc123","password":"hunter2","apiKey":"k-1"}'
    );

    expect(result).not.toContain('abc123');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('k-1');
    // The label survives, so a redacted line still says what was suppressed.
    expect(result).toContain('accessToken');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a password embedded in a URL', () => {
    const result = redactSecrets('connect ECONNREFUSED https://admin:hunter2@budget.example.com');

    expect(result).not.toContain('hunter2');
    expect(result).toContain('https://admin:[REDACTED]@budget.example.com');
  });

  it('caps the length and says how much it dropped', () => {
    const result = redactSecrets('x'.repeat(constants.MAX_ERROR_MESSAGE_LENGTH + 100));

    expect(result).toMatch(/… \[truncated 100 chars\]$/);
    expect(result.length).toBeLessThan(constants.MAX_ERROR_MESSAGE_LENGTH + 40);
  });

  it('returns an empty string for anything that is not a usable string', () => {
    for (const value of ['', null, undefined, 42, {}]) {
      expect(redactSecrets(value)).toBe('');
    }
  });
});

describe('errorMessageOf', () => {
  it('reads the message from an Error', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
  });

  it('accepts a bare string', () => {
    expect(errorMessageOf('boom')).toBe('boom');
  });

  it('accepts a plain object carrying a message', () => {
    expect(errorMessageOf({ message: 'boom' })).toBe('boom');
  });

  it('describes a rejection that carries no message instead of throwing', () => {
    // The reason this helper exists: `error.message.includes(...)` on one of these
    // throws a TypeError from inside a catch block, destroying both the original
    // failure and the audit event that was about to be written.
    expect(errorMessageOf(null)).toBe('Non-error rejection of type null');
    expect(errorMessageOf(undefined)).toBe('Non-error rejection of type undefined');
    expect(errorMessageOf({ status: 500 })).toBe('Non-error rejection of type object');
    expect(errorMessageOf(42)).toBe('Non-error rejection of type number');
  });

  it('redacts on every branch', () => {
    process.env.ACTUAL_BUDGET_PASS = 'leaky-password';
    try {
      expect(errorMessageOf(new Error('used leaky-password'))).not.toContain('leaky-password');
      expect(errorMessageOf('used leaky-password')).not.toContain('leaky-password');
      expect(errorMessageOf({ message: 'used leaky-password' })).not.toContain('leaky-password');
    } finally {
      delete process.env.ACTUAL_BUDGET_PASS;
    }
  });
});

describe('sanitizeError', () => {
  it('keeps only the named fields and never the stack', () => {
    const error = new Error('something failed');
    error.code = 'ECONNRESET';

    const result = sanitizeError(error);

    expect(result).toEqual({
      message: 'something failed',
      code: 'ECONNRESET',
      name: 'Error',
    });
    expect(result.stack).toBeUndefined();
  });

  it('drops the axios request configuration entirely', () => {
    // axios attaches `config` — including the Authorization header — and `request`
    // to its errors. Naming the fields we keep means a future change here cannot
    // start picking them up.
    const error = new Error('Request failed with status code 401');
    error.config = { headers: { Authorization: 'Bearer super-secret' } };
    error.request = { path: '/api/v1/account' };
    error.response = { data: { token: 'another-secret' } };

    const result = sanitizeError(error);

    expect(Object.keys(result).sort()).toEqual(['code', 'message', 'name']);
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('another-secret');
  });

  it('redacts the message', () => {
    process.env.GHOSTFOLIO_TOKEN = 'token-that-must-not-leak';
    try {
      const result = sanitizeError(new Error('rejected token-that-must-not-leak'));

      expect(result.message).not.toContain('token-that-must-not-leak');
    } finally {
      delete process.env.GHOSTFOLIO_TOKEN;
    }
  });

  it('describes a non-Error value rather than serializing it', () => {
    expect(sanitizeError(null)).toEqual({
      message: 'Non-error rejection of type null',
      code: undefined,
      name: 'null',
    });

    const result = sanitizeError({ secretField: 'do-not-log-me' });

    expect(JSON.stringify(result)).not.toContain('do-not-log-me');
  });
});

// validateApiResponse is gone; the response shape checks it fronted now live at
// their point of use in ghostfolio.js, where they are stricter than a presence
// test. tests/ghostfolio.test.js covers them against real response bodies.
