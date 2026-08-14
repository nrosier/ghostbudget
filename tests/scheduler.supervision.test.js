const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The scheduler is the container's supervisor. Everything below is about the parts
// that decide whether a wedged sync gets killed, whether two runs can open the same
// SQLite file at once, and whether `docker stop` is honoured — so the child process
// is faked and the outcomes are asserted, rather than spawning real syncs.
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args) => mockSpawn(...args),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/utils/audit', () => ({
  logSync: jest.fn(),
  logAuth: jest.fn(),
  logBalanceUpdate: jest.fn(),
  logSecurityEvent: jest.fn(),
  logValidationFailure: jest.fn(),
}));
jest.mock('../src/utils/exit', () => ({ flushLogsAndExit: jest.fn() }));

const logger = require('../src/logger');
const AuditLogger = require('../src/utils/audit');
const constants = require('../src/config/constants');
const { flushLogsAndExit } = require('../src/utils/exit');
const scheduler = require('../src/scheduler');

/**
 * A stand-in for a spawned sync process.
 *
 * @returns {EventEmitter} Fake child with a recording kill()
 */
function fakeChild() {
  const proc = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

describe('scheduler supervision', () => {
  let workDir;
  let healthFile;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-sched-'));
    healthFile = path.join(workDir, 'health.json');
    process.env.GHOSTBUDGET_HEALTH_FILE = healthFile;

    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => fakeChild());
    Object.values(logger).forEach((fn) => fn.mockClear && fn.mockClear());
    Object.values(AuditLogger).forEach((fn) => fn.mockClear && fn.mockClear());
    flushLogsAndExit.mockClear();
    scheduler.__resetForTests();
  });

  afterEach(() => {
    scheduler.__resetForTests();
    delete process.env.GHOSTBUDGET_HEALTH_FILE;
    fs.rmSync(workDir, { recursive: true, force: true });
    jest.useRealTimers();
  });

  describe('writeState', () => {
    it('publishes a heartbeat the health check can read', () => {
      scheduler.writeState();

      const written = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      expect(written.pid).toBe(process.pid);
      expect(Date.parse(written.heartbeatAt)).toBeLessThanOrEqual(Date.now());
    });

    it('leaves no temp file behind and keeps the file owner-only', () => {
      // The write goes to a temp path and is renamed so the health check can never
      // read a half-written document; the temp file must not survive the rename.
      scheduler.writeState();

      expect(fs.readdirSync(workDir)).toEqual(['health.json']);
      expect(fs.statSync(healthFile).mode & 0o777).toBe(0o600);
    });

    it('always leaves valid JSON in place, never a truncated document', () => {
      for (let i = 0; i < 5; i += 1) {
        scheduler.writeState();
        expect(() => JSON.parse(fs.readFileSync(healthFile, 'utf8'))).not.toThrow();
      }
    });

    it('warns instead of throwing when the file cannot be written', () => {
      // A read-only or missing state directory must not take the scheduler down: a
      // missing health file already makes the container unhealthy, which is correct.
      process.env.GHOSTBUDGET_HEALTH_FILE = path.join(workDir, 'nope', 'health.json');

      expect(() => scheduler.writeState()).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        'Could not write health state file',
        expect.objectContaining({ file: expect.stringContaining('nope') })
      );
    });
  });

  describe('runSync', () => {
    it('runs the sync as a separate process with inherited output', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();
      const [command, args, options] = mockSpawn.mock.calls[0];

      expect(command).toBe(process.execPath);
      expect(args).toEqual([path.join(__dirname, '..', 'src', 'index.js')]);
      // Inherited stdio is what puts the sync's output in `docker logs`; stdin is
      // ignored because a scheduled job has no console to read from.
      expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit']);
      expect(options.cwd).toBe(path.join(__dirname, '..'));

      child.emit('close', 0, null);
      await expect(finished).resolves.toMatchObject({ outcome: 'success', exitCode: 0 });
    });

    it('marks the run in progress while it is running and clears it afterwards', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();

      expect(scheduler.state.running).toBe(true);
      expect(JSON.parse(fs.readFileSync(healthFile, 'utf8')).running).toBe(true);

      child.emit('close', 0, null);
      await finished;

      expect(scheduler.state.running).toBe(false);
      expect(scheduler.state.runStartedAt).toBeNull();
      expect(JSON.parse(fs.readFileSync(healthFile, 'utf8')).running).toBe(false);
    });

    it('records a non-zero exit as a failure without rejecting', async () => {
      // Rejecting here would take the scheduler down with the sync, and the next
      // run might well have succeeded.
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();
      child.emit('close', 1, null);

      await expect(finished).resolves.toMatchObject({ outcome: 'failure', exitCode: 1 });
      expect(scheduler.state.failureCount).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Scheduled sync failed',
        expect.objectContaining({ outcome: 'failure', failures_total: 1 })
      );
    });

    it('reports the signal when the sync is killed from outside', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();
      child.emit('close', null, 'SIGKILL');

      await expect(finished).resolves.toMatchObject({ outcome: 'signal:SIGKILL' });
      expect(scheduler.state.failureCount).toBe(1);
    });

    it('reports a spawn failure rather than hanging forever', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();
      child.emit('error', new Error('ENOENT'));

      await expect(finished).resolves.toMatchObject({ outcome: 'spawn_error', exitCode: null });
      expect(logger.error).toHaveBeenCalledWith(
        'Could not start sync process',
        expect.objectContaining({ message: expect.stringContaining('ENOENT') })
      );
    });

    it('does not settle twice when a spawn error is followed by a close', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();
      child.emit('error', new Error('ENOENT'));
      child.emit('close', 1, null);

      await expect(finished).resolves.toMatchObject({ outcome: 'spawn_error' });
      expect(scheduler.state.failureCount).toBe(1);
    });

    it('terminates a sync that overruns its time limit, then escalates to SIGKILL', async () => {
      // A sync wedged inside a native better-sqlite3 call may never act on SIGTERM.
      // Without the escalation the process leaks and the scheduler waits forever.
      jest.useFakeTimers();
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();

      jest.advanceTimersByTime(constants.SYNC_TIMEOUT_MS);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(AuditLogger.logSync).toHaveBeenCalledWith(
        'failed',
        expect.objectContaining({ error_type: 'timeout' })
      );

      jest.advanceTimersByTime(constants.SYNC_SIGKILL_GRACE_MS);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      child.emit('close', null, 'SIGKILL');
      await expect(finished).resolves.toMatchObject({ outcome: 'timeout' });
    });

    it('does not kill a sync that finishes inside its time limit', async () => {
      jest.useFakeTimers();
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const finished = scheduler.runSync();
      child.emit('close', 0, null);
      await finished;

      // The timeout timer has to be cleared on completion; otherwise it fires later
      // and kills whichever process happens to be current.
      jest.advanceTimersByTime(constants.SYNC_TIMEOUT_MS * 2);
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  describe('onTick', () => {
    it('runs a sync on a tick', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);

      const ticked = scheduler.onTick();
      child.emit('close', 0, null);
      await ticked;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(scheduler.state.runCount).toBe(1);
    });

    it('skips the tick while a sync is still in progress', async () => {
      // Two overlapping runs would open the same Actual Budget SQLite database.
      // BusyBox cron did exactly that.
      const first = fakeChild();
      mockSpawn.mockReturnValue(first);
      const running = scheduler.runSync();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      await scheduler.onTick();

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(AuditLogger.logSync).toHaveBeenCalledWith('skipped', {
        reason: 'previous_run_in_progress',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('previous run is still in progress'),
        expect.any(Object)
      );

      first.emit('close', 0, null);
      await running;
    });

    it('does not start a new sync once shutdown has begun', async () => {
      scheduler.shutdown('SIGTERM');
      mockSpawn.mockClear();

      await scheduler.onTick();

      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('exits straight away when no sync is running', () => {
      scheduler.shutdown('SIGTERM');

      expect(logger.info).toHaveBeenCalledWith(
        'Received SIGTERM, shutting down scheduler',
        expect.objectContaining({ sync_in_progress: false })
      );
      expect(flushLogsAndExit).toHaveBeenCalledWith(0);
    });

    it('asks an in-flight sync to stop and waits for it', async () => {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);
      const running = scheduler.runSync();

      scheduler.shutdown('SIGTERM');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(flushLogsAndExit).not.toHaveBeenCalled();

      child.emit('close', 0, 'SIGTERM');
      await running;

      expect(flushLogsAndExit).toHaveBeenCalledWith(0);
    });

    it('kills a sync that ignores SIGTERM within the grace period', async () => {
      // The grace period is deliberately under Docker's 10 s stop timeout so the
      // scheduler exits on its own terms rather than being SIGKILLed by the daemon.
      jest.useFakeTimers();
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);
      const running = scheduler.runSync();

      scheduler.shutdown('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      jest.advanceTimersByTime(constants.SHUTDOWN_GRACE_MS);

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(flushLogsAndExit).toHaveBeenCalledWith(0);
      expect(logger.warn).toHaveBeenCalledWith(
        'Sync did not stop in time, killing it',
        expect.objectContaining({ grace_ms: constants.SHUTDOWN_GRACE_MS })
      );

      child.emit('close', null, 'SIGKILL');
      await running;
    });

    it('ignores a second signal', () => {
      scheduler.shutdown('SIGTERM');
      scheduler.shutdown('SIGINT');

      expect(flushLogsAndExit).toHaveBeenCalledTimes(1);
    });
  });

  describe('main', () => {
    const EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'];
    let added;

    /**
     * Run main() and isolate the process handlers it registers.
     *
     * @returns {void}
     */
    function start() {
      const before = new Map(EVENTS.map((event) => [event, process.listeners(event)]));
      scheduler.main();
      added = new Map(
        EVENTS.map((event) => [
          event,
          process.listeners(event).filter((listener) => !before.get(event).includes(listener)),
        ])
      );
    }

    afterEach(() => {
      if (added) {
        added.forEach((listeners, event) =>
          listeners.forEach((listener) => process.removeListener(event, listener))
        );
        added = null;
      }
      delete process.env.CRON_TASK;
      delete process.env.ACTUAL_BUDGET_DATA_DIR;
    });

    it('starts scheduling and publishes its state', () => {
      process.env.CRON_TASK = '0 5 * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = workDir;

      start();

      expect(flushLogsAndExit).not.toHaveBeenCalled();
      expect(scheduler.state.schedule).toBe('0 5 * * *');
      const written = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      expect(written.schedule).toBe('0 5 * * *');
      expect(Date.parse(written.nextRunAt)).toBeGreaterThan(Date.now());
      expect(logger.info).toHaveBeenCalledWith(
        'GhostBudget scheduler started',
        expect.objectContaining({ schedule: '0 5 * * *', upcoming_runs: expect.any(Array) })
      );
    });

    it('exits rather than idling when CRON_TASK is unusable', () => {
      // A scheduler that starts with a broken schedule looks healthy and syncs
      // nothing, which is the worst of the available outcomes.
      process.env.CRON_TASK = '0 5 * * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = workDir;

      start();

      expect(flushLogsAndExit).toHaveBeenCalledWith(1);
      expect(AuditLogger.logValidationFailure).toHaveBeenCalledWith(
        'scheduler_config',
        expect.objectContaining({ details: expect.stringContaining('exactly five fields') })
      );
      expect(scheduler.state.schedule).toBeNull();
    });

    it('exits when the data directory is unusable', () => {
      process.env.CRON_TASK = '0 5 * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = path.join(workDir, 'not-created');

      start();

      expect(flushLogsAndExit).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Scheduler configuration is invalid',
        expect.objectContaining({ message: expect.stringContaining('does not exist') })
      );
    });

    it('keeps the heartbeat ticking after startup', () => {
      // A stale heartbeat is how the health check notices a dead event loop, so the
      // interval existing is the whole basis of the container's liveness signal.
      jest.useFakeTimers();
      process.env.CRON_TASK = '0 5 * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = workDir;

      start();
      const first = JSON.parse(fs.readFileSync(healthFile, 'utf8')).heartbeatAt;

      jest.setSystemTime(Date.now() + constants.HEARTBEAT_INTERVAL_MS + 1000);
      jest.advanceTimersByTime(constants.HEARTBEAT_INTERVAL_MS);

      expect(JSON.parse(fs.readFileSync(healthFile, 'utf8')).heartbeatAt).not.toBe(first);
    });

    it('exits non-zero on an unhandled rejection instead of scheduling nothing', () => {
      process.env.CRON_TASK = '0 5 * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = workDir;

      start();
      added.get('unhandledRejection')[0](new Error('nothing awaited this'));

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled Rejection in scheduler',
        expect.objectContaining({ message: expect.stringContaining('nothing awaited this') })
      );
      expect(flushLogsAndExit).toHaveBeenCalledWith(1);
    });

    it('exits non-zero on an uncaught exception', () => {
      process.env.CRON_TASK = '0 5 * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = workDir;

      start();
      added.get('uncaughtException')[0](new Error('boom'));

      expect(logger.error).toHaveBeenCalledWith(
        'Uncaught Exception in scheduler',
        expect.objectContaining({ message: expect.stringContaining('boom') })
      );
      expect(flushLogsAndExit).toHaveBeenCalledWith(1);
    });

    it('honours SIGTERM from the registered handler', () => {
      process.env.CRON_TASK = '0 5 * * *';
      process.env.ACTUAL_BUDGET_DATA_DIR = workDir;

      start();
      added.get('SIGTERM')[0]();

      expect(flushLogsAndExit).toHaveBeenCalledWith(0);
    });
  });
});
