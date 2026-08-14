const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { evaluateHealth, readState, main } = require('../src/healthcheck');
const constants = require('../src/config/constants');

const NOW = Date.parse('2026-08-13T12:00:00.000Z');

function stateFile(overrides = {}) {
  return JSON.stringify({
    pid: 1,
    schedule: '0 5 * * *',
    startedAt: '2026-08-13T11:00:00.000Z',
    heartbeatAt: new Date(NOW - 5000).toISOString(),
    nextRunAt: '2026-08-14T05:00:00.000Z',
    running: false,
    lastRunOutcome: 'success',
    failureCount: 0,
    ...overrides,
  });
}

describe('healthcheck', () => {
  it('reports healthy on a fresh heartbeat', () => {
    const verdict = evaluateHealth(stateFile(), NOW);

    expect(verdict.healthy).toBe(true);
    expect(verdict.state.schedule).toBe('0 5 * * *');
  });

  it('reports unhealthy when no state file exists', () => {
    // This is the case the old `node -e "process.exit(0)"` check could not see:
    // the scheduler never started, or died before writing anything.
    for (const missing of [null, undefined, '']) {
      const verdict = evaluateHealth(missing, NOW);
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toMatch(/no health state file/);
    }
  });

  it('reports unhealthy when the heartbeat has gone stale', () => {
    const stale = new Date(NOW - constants.HEALTH_MAX_STALE_MS - 1000).toISOString();

    const verdict = evaluateHealth(stateFile({ heartbeatAt: stale }), NOW);

    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toMatch(/heartbeat is \d+ ms old/);
  });

  it('tolerates a heartbeat right up to the limit', () => {
    const edge = new Date(NOW - constants.HEALTH_MAX_STALE_MS).toISOString();

    expect(evaluateHealth(stateFile({ heartbeatAt: edge }), NOW).healthy).toBe(true);
  });

  it('reports unhealthy on an unparseable or heartbeat-less file', () => {
    expect(evaluateHealth('{not json', NOW).healthy).toBe(false);
    expect(evaluateHealth(stateFile({ heartbeatAt: undefined }), NOW).healthy).toBe(false);
    expect(evaluateHealth(stateFile({ heartbeatAt: 'never' }), NOW).healthy).toBe(false);
  });

  it('stays healthy when the last sync failed', () => {
    // A remote outage must not restart the container: restarting fixes nothing
    // and turns someone else's downtime into a crash loop here.
    const verdict = evaluateHealth(
      stateFile({ lastRunOutcome: 'failure', lastRunExitCode: 1, failureCount: 7 }),
      NOW
    );

    expect(verdict.healthy).toBe(true);
  });
});

describe('readState', () => {
  let file;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-health-')), 'state.json');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('returns the file contents', () => {
    fs.writeFileSync(file, stateFile());

    expect(JSON.parse(readState(file)).schedule).toBe('0 5 * * *');
  });

  it('returns null rather than throwing when the file is unavailable', () => {
    // The scheduler not having written yet is the normal state during startup, and
    // a health check that throws is a health check that reports nothing useful.
    expect(readState(file)).toBeNull();
    expect(readState(path.dirname(file))).toBeNull(); // EISDIR
  });
});

describe('main', () => {
  let dir;
  let exitSpy;
  let logSpy;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-health-'));
    process.env.GHOSTBUDGET_HEALTH_FILE = path.join(dir, 'state.json');
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.GHOSTBUDGET_HEALTH_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 and summarises the state when the scheduler is ticking', () => {
    fs.writeFileSync(
      process.env.GHOSTBUDGET_HEALTH_FILE,
      stateFile({
        heartbeatAt: new Date().toISOString(),
      })
    );

    main();

    expect(exitSpy).toHaveBeenCalledWith(0);
    const summary = logSpy.mock.calls[0][0];
    expect(summary).toMatch(/^healthy \| heartbeat is \d+ ms old/);
    expect(summary).toContain('schedule=0 5 * * *');
    expect(summary).toContain('last=success');
    expect(summary).toContain('next=2026-08-14T05:00:00.000Z');
    expect(summary).toContain('failures=0');
  });

  it('exits 1 when there is no state file at all', () => {
    main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^UNHEALTHY \| no health state file/);
  });

  it('exits 1 on a stale heartbeat', () => {
    fs.writeFileSync(
      process.env.GHOSTBUDGET_HEALTH_FILE,
      stateFile({
        heartbeatAt: new Date(Date.now() - constants.HEALTH_MAX_STALE_MS - 1000).toISOString(),
      })
    );

    main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^UNHEALTHY \| heartbeat is/);
  });

  it('reports a sync in progress instead of the previous outcome', () => {
    fs.writeFileSync(
      process.env.GHOSTBUDGET_HEALTH_FILE,
      stateFile({
        heartbeatAt: new Date().toISOString(),
        running: true,
      })
    );

    main();

    expect(logSpy.mock.calls[0][0]).toContain('sync=running');
    expect(logSpy.mock.calls[0][0]).not.toContain('last=');
  });

  it('summarises what it can when the file is unparseable', () => {
    // verdict.state is null here, so every optional field has to be skipped
    // without throwing on a property of null.
    fs.writeFileSync(process.env.GHOSTBUDGET_HEALTH_FILE, '{truncated');

    main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls[0][0]).toBe('UNHEALTHY | health state file is not valid JSON');
  });
});

describe('healthcheck as Docker runs it', () => {
  // The exported main() is called in-process above with process.exit stubbed. This
  // runs the file the way HEALTHCHECK does — `node src/healthcheck.js` — because
  // the exit *status* is the entire contract with Docker, and a stubbed exit cannot
  // prove the process actually returns it.
  const script = path.join(__dirname, '..', 'src', 'healthcheck.js');
  let dir;

  /**
   * Run the health check as a child process.
   *
   * @param {string} stateFilePath - Value for GHOSTBUDGET_HEALTH_FILE
   * @returns {{status: number, stdout: string}} Exit status and captured output
   */
  function run(stateFilePath) {
    try {
      const stdout = execFileSync(process.execPath, [script], {
        env: { ...process.env, GHOSTBUDGET_HEALTH_FILE: stateFilePath },
        encoding: 'utf8',
      });
      return { status: 0, stdout };
    } catch (error) {
      return { status: error.status, stdout: error.stdout };
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-health-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits non-zero when the scheduler has never written a heartbeat', () => {
    const result = run(path.join(dir, 'missing.json'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UNHEALTHY');
  });

  it('exits zero on a live heartbeat', () => {
    const live = path.join(dir, 'state.json');
    fs.writeFileSync(live, stateFile({ heartbeatAt: new Date().toISOString() }));

    const result = run(live);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('healthy');
  });
});
