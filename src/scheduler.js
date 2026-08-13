#!/usr/bin/env node
/**
 * GhostBudget scheduler — the container's long-lived process.
 *
 * This replaces the previous BusyBox `crond` setup, and with it an entire class
 * of fragility:
 *
 * - The container no longer has a root phase. `crond` had to start as root to
 *   install a crontab for another user, so PID 1 ran as root for the container's
 *   whole lifetime and only the sync itself dropped to `nodejs`. This process
 *   runs as `nodejs` from the first instruction.
 * - Secrets no longer depend on a BusyBox quirk. The old design wrote
 *   non-sensitive variables to /app/project_env.sh and relied on BusyBox `crond`
 *   leaking its own environment to jobs for ACTUAL_BUDGET_PASS and
 *   GHOSTFOLIO_TOKEN to arrive at all. Vixie cron and cronie build a clean
 *   environment and would have dropped both, so any change of base image would
 *   have broken authentication. A child process inherits the environment
 *   directly, by definition.
 * - CRON_TASK is no longer interpolated into a shell command line, so a real
 *   parser can validate it instead of a character allowlist.
 *
 * Each run is still a separate OS process. That is deliberate: @actual-app/api
 * opens a native better-sqlite3 handle and a sync that dies before
 * api.shutdown() leaves it behind, so process-per-run keeps a bad run from
 * poisoning the next one — the same isolation cron gave us for free.
 */

// Load environment variables first
require('dotenv').config();

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Cron } = require('croner');

const logger = require('./logger');
const AuditLogger = require('./utils/audit');
const constants = require('./config/constants');
const { flushLogsAndExit } = require('./utils/exit');
const { validateDataDir, sanitizeError } = require('./utils/validation');

const SYNC_SCRIPT = path.join(__dirname, 'index.js');
const APP_ROOT = path.join(__dirname, '..');

/**
 * Cron nicknames croner understands. `@reboot` is excluded because croner
 * rejects it, and because "on start" is a different feature from a schedule.
 */
const CRON_NICKNAMES = [
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
];

/**
 * Validate and normalize a CRON_TASK value.
 *
 * The old shell validation only checked which characters appeared, so it accepted
 * `* * * * * * *` and rejected `@daily`. Both are fixed here: the field count is
 * checked, nicknames are supported, and croner parses the pattern so out-of-range
 * values and patterns that can never match are caught at startup instead of
 * turning into a schedule nobody asked for.
 *
 * @param {*} expression - Raw CRON_TASK value
 * @returns {{pattern: string, upcoming: Date[]}} Normalized pattern and next run times
 * @throws {Error} If the expression is unusable
 */
function normalizeSchedule(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error(
      'CRON_TASK is not set. Provide a five-field cron expression such as "0 5 * * *", ' +
        `or one of: ${CRON_NICKNAMES.join(', ')}.`
    );
  }

  const pattern = expression.trim().replace(/\s+/g, ' ');

  if (pattern.startsWith('@')) {
    if (!CRON_NICKNAMES.includes(pattern.toLowerCase())) {
      throw new Error(
        `Unsupported CRON_TASK nickname "${pattern}". Supported: ${CRON_NICKNAMES.join(', ')}.`
      );
    }
  } else {
    const fields = pattern.split(' ');
    if (fields.length !== 5) {
      // Six- and seven-field patterns are rejected on purpose. croner reads the
      // extra leading field as seconds, so a stray sixth field silently changes
      // the meaning of the whole expression: "0 5 * * * *" becomes "at second 0
      // of minute 5 of every hour" — 24 syncs a day instead of one.
      throw new Error(
        `CRON_TASK must have exactly five fields (minute hour day-of-month month day-of-week), ` +
          `got ${fields.length} in "${pattern}". Second-level and year fields are not accepted: ` +
          'an extra field shifts the meaning of every other field.'
      );
    }
  }

  // Semantic validation. croner throws on out-of-range values, and returns no
  // run times for a pattern that can never match (e.g. "0 5 31 2 *").
  const probe = new Cron(pattern, { paused: true });
  let upcoming;
  try {
    upcoming = probe.nextRuns(3) || [];
  } finally {
    probe.stop();
  }

  if (upcoming.length === 0) {
    throw new Error(`CRON_TASK "${pattern}" has no future run times and would never fire.`);
  }

  return { pattern, upcoming };
}

/**
 * Scheduler state, mirrored to disk for the container health check.
 */
const state = {
  pid: process.pid,
  schedule: null,
  startedAt: null,
  heartbeatAt: null,
  nextRunAt: null,
  running: false,
  runStartedAt: null,
  lastRunFinishedAt: null,
  lastRunOutcome: null,
  lastRunExitCode: null,
  lastRunDurationMs: null,
  runCount: 0,
  failureCount: 0,
};

let job = null;
let heartbeat = null;
let child = null;
let isShuttingDown = false;

/**
 * Publish scheduler state for the health check.
 *
 * Written via a temp file and rename so the health check can never observe a
 * half-written JSON document and report a healthy scheduler as broken.
 */
function writeState() {
  state.heartbeatAt = new Date().toISOString();

  const file = constants.healthStateFile();
  const temp = `${file}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    // A missing health file makes the container unhealthy, which is the correct
    // outcome, so this is a warning rather than a fatal error.
    logger.warn('Could not write health state file', { file, ...sanitizeError(error) });
  }
}

/**
 * Run one sync in a child process.
 *
 * Resolves rather than rejects on failure: a sync that fails because a remote
 * server is down must not take the scheduler with it — the next run may succeed.
 *
 * @returns {Promise<{outcome: string, exitCode: number|null, durationMs: number}>} Run result
 */
function runSync() {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    state.running = true;
    state.runStartedAt = new Date(startedAt).toISOString();
    state.runCount += 1;
    writeState();

    logger.info('Starting scheduled sync', { run: state.runCount });

    let settled = false;
    let timedOut = false;
    let killTimer = null;

    // stdout/stderr are inherited so the sync's console output reaches `docker
    // logs` directly. The old design appended it to /var/log/cron.log and kept a
    // `tail -f` alive to relay it.
    child = spawn(process.execPath, [SYNC_SCRIPT], {
      cwd: APP_ROOT,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.error('Sync exceeded its time limit, terminating', {
        run: state.runCount,
        timeout_ms: constants.SYNC_TIMEOUT_MS,
      });
      AuditLogger.logSync('failed', {
        error: 'sync timed out',
        error_type: 'timeout',
        duration_ms: Date.now() - startedAt,
      });

      if (child) {
        child.kill('SIGTERM');
        // A sync wedged inside a native better-sqlite3 call may not act on
        // SIGTERM at all, so escalate rather than leaking the process.
        killTimer = setTimeout(
          () => child && child.kill('SIGKILL'),
          constants.SYNC_SIGKILL_GRACE_MS
        );
      }
    }, constants.SYNC_TIMEOUT_MS);

    const finish = (outcome, exitCode) => {
      if (settled) {
        return;
      }
      settled = true;

      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      child = null;

      const durationMs = Date.now() - startedAt;
      state.running = false;
      state.runStartedAt = null;
      state.lastRunFinishedAt = new Date().toISOString();
      state.lastRunOutcome = outcome;
      state.lastRunExitCode = exitCode;
      state.lastRunDurationMs = durationMs;
      state.nextRunAt = job ? nextRunIso() : null;
      if (outcome !== 'success') {
        state.failureCount += 1;
      }
      writeState();

      const details = {
        run: state.runCount,
        outcome,
        exit_code: exitCode,
        duration_ms: durationMs,
        next_run: state.nextRunAt,
      };

      if (outcome === 'success') {
        logger.info('Scheduled sync finished', details);
      } else {
        logger.error('Scheduled sync failed', { ...details, failures_total: state.failureCount });
      }

      resolve({ outcome, exitCode, durationMs });
    };

    child.on('error', (error) => {
      logger.error('Could not start sync process', sanitizeError(error));
      finish('spawn_error', null);
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish('timeout', code);
      } else if (signal) {
        finish(`signal:${signal}`, code);
      } else {
        finish(code === 0 ? 'success' : 'failure', code);
      }
    });
  });
}

/**
 * @returns {string|null} ISO timestamp of the next scheduled run
 */
function nextRunIso() {
  const next = job && job.nextRun();
  return next ? next.toISOString() : null;
}

/**
 * Cron tick handler. Skips the run if the previous one is still going.
 */
async function onTick() {
  if (isShuttingDown) {
    return;
  }

  if (state.running) {
    // Overlapping runs would have two processes opening the same Actual Budget
    // SQLite database. BusyBox cron happily did exactly that.
    logger.warn('Skipping scheduled sync: previous run is still in progress', {
      run_started_at: state.runStartedAt,
    });
    AuditLogger.logSync('skipped', { reason: 'previous_run_in_progress' });
    state.nextRunAt = nextRunIso();
    writeState();
    return;
  }

  await runSync();
}

/**
 * Stop scheduling, let an in-flight sync finish if it can, then exit.
 *
 * tini is PID 1 and forwards SIGTERM here, so `docker stop` reaches this handler
 * instead of timing out against a shell that ignored it.
 *
 * @param {string} signal - Signal that triggered shutdown
 */
function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down scheduler`, {
    sync_in_progress: state.running,
  });

  if (job) {
    job.stop();
    job = null;
  }
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (!child) {
    flushLogsAndExit(0);
    return;
  }

  const running = child;
  const force = setTimeout(() => {
    logger.warn('Sync did not stop in time, killing it', {
      grace_ms: constants.SHUTDOWN_GRACE_MS,
    });
    running.kill('SIGKILL');
    flushLogsAndExit(0);
  }, constants.SHUTDOWN_GRACE_MS);
  force.unref();

  running.once('close', () => {
    clearTimeout(force);
    flushLogsAndExit(0);
  });
  running.kill('SIGTERM');
}

/**
 * Start the scheduler.
 */
function main() {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // The scheduler is the container's supervisor; if its own state is broken it
  // must exit and let the restart policy replace it rather than sit there
  // scheduling nothing.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection in scheduler', sanitizeError(reason));
    flushLogsAndExit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception in scheduler', sanitizeError(error));
    flushLogsAndExit(1);
  });

  let schedule;
  try {
    schedule = normalizeSchedule(process.env.CRON_TASK);
    validateDataDir(process.env.ACTUAL_BUDGET_DATA_DIR);
  } catch (error) {
    // Fail fast and loudly: a scheduler that starts with a bad schedule or an
    // unwritable data directory looks healthy and never syncs anything.
    logger.error('Scheduler configuration is invalid', sanitizeError(error));
    AuditLogger.logValidationFailure('scheduler_config', { details: error.message });
    flushLogsAndExit(1);
    return;
  }

  state.schedule = schedule.pattern;
  state.startedAt = new Date().toISOString();

  job = new Cron(schedule.pattern, onTick);
  state.nextRunAt = nextRunIso();

  // Print the next few run times so a mistyped schedule is obvious in the
  // startup log rather than only after a night of nothing happening.
  logger.info('GhostBudget scheduler started', {
    schedule: schedule.pattern,
    node_version: process.version,
    uid: typeof process.getuid === 'function' ? process.getuid() : 'unknown',
    upcoming_runs: schedule.upcoming.map((d) => d.toISOString()),
  });

  heartbeat = setInterval(writeState, constants.HEARTBEAT_INTERVAL_MS);
  writeState();
}

if (require.main === module) {
  main();
}

module.exports = { normalizeSchedule, CRON_NICKNAMES };
