/**
 * The environment a suite needs before it can load a service module.
 *
 * `validateEnvironment` validates the whole application schema at once, so a test about
 * Actual Budget still needs the Ghostfolio variables present and vice versa. One copy of
 * them, rather than one per suite — see docs/decisions.md.
 *
 * Not under tests/ root: Jest's default testMatch would collect a file named
 * `tests/env.js` as a suite with no tests in it. `tests/helpers/` is not matched.
 */

// A UUID because that is what Ghostfolio's anonymous-user security token is, and
// because MIN_TOKEN_LENGTH is 16. Suites that exercise the token itself declare
// their own values — see ghostfolio.test.js, where the security token and the auth
// token are deliberately different so sending the wrong one cannot pass.
const TEST_TOKEN = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

const TEST_ENV = Object.freeze({
  ACTUAL_BUDGET_URL: 'http://localhost:5006',
  ACTUAL_BUDGET_PASS: 'test-pass',
  ACTUAL_BUDGET_SYNC_ID: 'test-sync-id',
  ACTUAL_BUDGET_DATA_DIR: '/test/dir',
  // Ghostfolio's own default port, and the base URL the nock interceptors use.
  GHOSTFOLIO_URL: 'http://localhost:3333',
  GHOSTFOLIO_TOKEN: TEST_TOKEN,
  NODE_ENV: 'test',
});

/**
 * Put a valid environment in place, and forget any validated copy of the last one.
 *
 * @param {Object} [overrides] - Variables to set instead; `undefined` deletes one
 * @returns {Object} The values applied, for a test that needs to assert on them
 */
function applyTestEnv(overrides = {}) {
  const entries = Object.entries(overrides);

  // Written this way, rather than assigning and deleting through `process.env[name]`,
  // because Object.assign would turn an `undefined` override into the string
  // "undefined" — and because a computed member write is what
  // security/detect-object-injection is about.
  Object.assign(
    process.env,
    TEST_ENV,
    Object.fromEntries(entries.filter(([, v]) => v !== undefined))
  );

  entries
    .filter(([, value]) => value === undefined)
    .forEach(([name]) => Reflect.deleteProperty(process.env, name));

  // getEnv() memoizes, deliberately — the environment cannot change under a running
  // process. It can under a test file, so the memo has to go when the values do.
  // Requiring it here rather than at module scope picks up the current registry,
  // which is the one a suite that has called jest.resetModules() is holding.
  require('../../src/config/env').__resetForTests();

  return { ...TEST_ENV, ...overrides };
}

module.exports = { TEST_ENV, TEST_TOKEN, applyTestEnv };
