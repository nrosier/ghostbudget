/**
 * Process exit helpers.
 *
 * Shared by the sync entry point and the scheduler so both terminate the same
 * way — a scheduler that lost its shutdown log would be just as blind as a sync
 * that lost its failure reason.
 */

const logger = require('../logger');
const constants = require('../config/constants');

/**
 * Exit once Winston has flushed, rather than immediately.
 *
 * Winston's File transports write asynchronously, so calling process.exit()
 * directly after logger.error() discards whatever is still buffered — which is
 * exactly the failure reason and the audit event that make the log useful. Wait
 * for the logger to finish, but bound the wait so a stuck transport cannot leave
 * the container hanging.
 *
 * @param {number} code - Process exit code
 */
function flushLogsAndExit(code) {
  // Set immediately so the code is correct even if the process ends another way.
  process.exitCode = code;

  let exited = false;
  const exit = () => {
    if (exited) {
      return;
    }
    exited = true;
    process.exit(code);
  };

  const timer = setTimeout(exit, constants.LOG_FLUSH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  logger.on('finish', exit);
  logger.end();
}

module.exports = { flushLogsAndExit };
