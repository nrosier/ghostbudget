const tls = require('tls');

const constants = require('../src/config/constants');

// @actual-app/api pulls in a native better-sqlite3 build; nothing here needs it.
jest.mock('@actual-app/api');

describe('TLS floor', () => {
  const originalMinVersion = tls.DEFAULT_MIN_VERSION;

  afterEach(() => {
    tls.DEFAULT_MIN_VERSION = originalMinVersion;
    jest.resetModules();
  });

  it('raises the process-wide default minimum version', () => {
    // The axios agent only covers the Ghostfolio leg. @actual-app/api creates its
    // own connections, which no agent option of ours reaches, so the floor has to
    // be set on the process.
    tls.DEFAULT_MIN_VERSION = 'TLSv1';
    jest.resetModules();

    require('../src/config/tls');

    expect(tls.DEFAULT_MIN_VERSION).toBe(constants.TLS_MIN_VERSION);
    expect(constants.TLS_MIN_VERSION).toBe('TLSv1.2');
  });

  it('is applied by loading either service module', () => {
    for (const moduleId of ['../src/ghostfolio', '../src/actualBudget']) {
      tls.DEFAULT_MIN_VERSION = 'TLSv1';
      jest.resetModules();

      process.env.GHOSTFOLIO_URL = 'http://localhost:3333';
      process.env.GHOSTFOLIO_TOKEN = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
      process.env.ACTUAL_BUDGET_URL = 'http://localhost:5006';
      process.env.ACTUAL_BUDGET_PASS = 'test-pass';
      process.env.ACTUAL_BUDGET_SYNC_ID = 'test-sync-id';

      // The whole point is that *either* entry point installs the floor, and the
      // ids are the two literals in the loop header above — nothing external.
      // eslint-disable-next-line security/detect-non-literal-require
      require(moduleId);

      expect(tls.DEFAULT_MIN_VERSION).toBe(constants.TLS_MIN_VERSION);
    }
  });

  it('pins a version range on the Ghostfolio agent without pinning ciphers', () => {
    // The previous allowlist permitted only ECDHE-RSA suites for TLS 1.2, which
    // fails the handshake outright against a server holding an ECDSA certificate —
    // Let's Encrypt ECDSA and Cloudflare both issue them. Its TLS 1.3 entries were
    // inert anyway: Node's `ciphers` option governs TLS 1.2 and below only.
    process.env.GHOSTFOLIO_URL = 'http://localhost:3333';
    process.env.GHOSTFOLIO_TOKEN = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
    process.env.ACTUAL_BUDGET_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_PASS = 'test-pass';
    process.env.ACTUAL_BUDGET_SYNC_ID = 'test-sync-id';
    jest.resetModules();

    const ghostfolio = require('../src/ghostfolio');
    const agentOptions = ghostfolio.axiosInstance.defaults.httpsAgent.options;

    expect(agentOptions.minVersion).toBe('TLSv1.2');
    expect(agentOptions.maxVersion).toBe('TLSv1.3');
    expect(agentOptions.rejectUnauthorized).toBe(true);
    expect(agentOptions.ciphers).toBeUndefined();
    expect(agentOptions.honorCipherOrder).toBeUndefined();
    expect(constants.TLS_CIPHERS).toBeUndefined();
  });
});
