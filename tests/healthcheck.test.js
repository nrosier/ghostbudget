const { evaluateHealth } = require('../src/healthcheck');
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
