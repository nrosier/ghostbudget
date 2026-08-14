const { validateEnvironment } = require('../utils/validation');

/**
 * The validated environment, read once per process.
 *
 * Two things make this worth a module of its own.
 *
 * *When* validation runs: on the first ask, not at require time. A module that
 * validates as a side effect of being required throws before its caller has installed
 * a single process handler, which means the failure reaches stderr and never reaches
 * combined.log or error.log — winston's file transports are asynchronous, and the
 * process is gone before the write lands.
 *
 * *How often*: once. The environment cannot change under a running process, so one
 * memoized result is the honest shape — two independent validations of the same
 * `process.env` could in principle disagree with each other.
 *
 * See docs/decisions.md for what the earlier arrangement cost an operator.
 */
let cached = null;

/**
 * @returns {Object} The frozen, validated environment
 * @throws {Error} If any variable is missing or malformed
 */
function getEnv() {
  cached ??= Object.freeze(validateEnvironment(process.env));
  return cached;
}

/**
 * Forget the memoized environment.
 *
 * For suites that change a variable between cases in one module registry. Callers
 * that already use `jest.resetModules()` get this for free.
 */
function __resetForTests() {
  cached = null;
}

module.exports = { getEnv, __resetForTests };
