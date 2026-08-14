const EventEmitter = require('events');

// A real EventEmitter so the 'finish' handshake is exercised rather than stubbed:
// the whole point of this helper is that the exit waits for winston.
const mockLogger = new EventEmitter();
mockLogger.end = jest.fn();
mockLogger.error = jest.fn();
mockLogger.info = jest.fn();

jest.mock('../src/logger', () => mockLogger);

const constants = require('../src/config/constants');
const { flushLogsAndExit } = require('../src/utils/exit');

describe('flushLogsAndExit', () => {
  let exitSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger.removeAllListeners('finish');
    mockLogger.end.mockClear();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('sets the exit code immediately, before any waiting', () => {
    // So the code is right even if the process ends by some other route.
    flushLogsAndExit(1);

    expect(process.exitCode).toBe(1);
  });

  it('waits for the logger to flush instead of exiting straight away', () => {
    // process.exit() right after logger.error() discards whatever the File
    // transports still have buffered — which is the failure reason and the audit
    // event that make the log worth having.
    flushLogsAndExit(0);

    expect(mockLogger.end).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    mockLogger.emit('finish');

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits anyway if the logger never finishes', () => {
    // A stuck transport must not leave the container hanging.
    flushLogsAndExit(1);
    expect(exitSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(constants.LOG_FLUSH_TIMEOUT_MS);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits exactly once when both the flush and the timeout fire', () => {
    flushLogsAndExit(1);

    mockLogger.emit('finish');
    jest.advanceTimersByTime(constants.LOG_FLUSH_TIMEOUT_MS * 2);
    mockLogger.emit('finish');

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let its own timer hold the event loop open', () => {
    // An un-unref'd timer would keep a process alive for the full flush timeout
    // after the work is done.
    const timers = [];
    const originalSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((...args) => {
      const timer = originalSetTimeout(...args);
      timers.push(timer);
      return timer;
    });

    try {
      flushLogsAndExit(0);

      expect(timers).toHaveLength(1);
      expect(timers[0].hasRef()).toBe(false);
    } finally {
      global.setTimeout.mockRestore();
      timers.forEach(clearTimeout);
    }
  });
});
