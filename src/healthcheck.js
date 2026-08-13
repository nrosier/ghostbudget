#!/usr/bin/env node
/**
 * Container health check.
 *
 * Replaces `node -e "process.exit(0)"`, which reported healthy no matter what was
 * happening — including the case the old design made likely, where `crond` had
 * died but `tail -f` kept PID 1 alive, so the container looked fine and never
 * synced again.
 *
 * Health here means "the scheduler is alive and still ticking", proven by a
 * heartbeat the scheduler refreshes on a timer. That checks the event loop is
 * running, not merely that a process exists.
 *
 * A failed *sync* deliberately does not make the container unhealthy. Syncs fail
 * for reasons outside this container — Actual Budget down, Ghostfolio
 * unreachable, credentials rotated — and restarting on those would turn a remote
 * outage into a crash loop that fixes nothing. Sync outcomes are reported in the
 * output for diagnosis, and are visible in the audit log.
 *
 * Requires only `constants` on purpose: pulling in Winston would create log files
 * and pay transport setup on every health probe.
 */

const fs = require('fs');
const constants = require('./config/constants');

/**
 * Decide whether the scheduler is healthy from its state file.
 *
 * @param {string|null} raw - Raw file contents, or null if unreadable
 * @param {number} now - Current time in ms since epoch
 * @returns {{healthy: boolean, reason: string, state: Object|null}} Verdict
 */
function evaluateHealth(raw, now = Date.now()) {
  if (raw === null || raw === undefined || raw === '') {
    return {
      healthy: false,
      reason: 'no health state file: the scheduler has not started, or cannot write it',
      state: null,
    };
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return { healthy: false, reason: 'health state file is not valid JSON', state: null };
  }

  const heartbeat = Date.parse(state.heartbeatAt);
  if (!Number.isFinite(heartbeat)) {
    return { healthy: false, reason: 'health state file has no usable heartbeat', state };
  }

  const ageMs = now - heartbeat;
  if (ageMs > constants.HEALTH_MAX_STALE_MS) {
    return {
      healthy: false,
      reason: `heartbeat is ${ageMs} ms old, over the ${constants.HEALTH_MAX_STALE_MS} ms limit`,
      state,
    };
  }

  return { healthy: true, reason: `heartbeat is ${ageMs} ms old`, state };
}

/**
 * Read the state file, returning null rather than throwing if it is unavailable.
 *
 * @param {string} file - Path to the state file
 * @returns {string|null} File contents
 */
function readState(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const file = constants.healthStateFile();
  const verdict = evaluateHealth(readState(file));
  const state = verdict.state || {};

  const summary = [
    verdict.healthy ? 'healthy' : 'UNHEALTHY',
    verdict.reason,
    state.schedule ? `schedule=${state.schedule}` : null,
    state.running ? 'sync=running' : state.lastRunOutcome ? `last=${state.lastRunOutcome}` : null,
    state.nextRunAt ? `next=${state.nextRunAt}` : null,
    Number.isInteger(state.failureCount) ? `failures=${state.failureCount}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  console.log(summary);
  process.exit(verdict.healthy ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { evaluateHealth };
