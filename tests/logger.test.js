const fs = require('fs');
const os = require('os');
const path = require('path');

// The logger is built at require time, so every test here has to reset the module
// registry and re-require it under a different environment. NODE_ENV is set to
// production deliberately: under 'test' the logger installs a single silent
// transport and buildFileTransports() is never reached.
describe('logger file transports', () => {
  const originalEnv = { ...process.env };
  let tempRoot;
  let built;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-logger-'));
    built = null;
  });

  afterEach(() => {
    if (built) {
      built.close();
    }
    process.env = { ...originalEnv };
    jest.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * Re-require the logger with a given log directory.
   *
   * @param {string|undefined} logDir - Value for GHOSTBUDGET_LOG_DIR
   * @returns {Object} A fresh winston logger
   */
  function loadLogger(logDir) {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    if (logDir === undefined) {
      delete process.env.GHOSTBUDGET_LOG_DIR;
    } else {
      process.env.GHOSTBUDGET_LOG_DIR = logDir;
    }

    built = require('../src/logger');
    return built;
  }

  /**
   * The file transports of a logger, with their resolved directories.
   *
   * @param {Object} logger - A winston logger
   * @returns {Array<Object>} File transports
   */
  function fileTransports(logger) {
    return logger.transports.filter((transport) => typeof transport.dirname === 'string');
  }

  it('creates the log directory, including missing parents', () => {
    const target = path.join(tempRoot, 'nested', 'deeper', 'logs');

    loadLogger(target);

    expect(fs.existsSync(target)).toBe(true);
  });

  it('writes both transports inside that directory as absolute paths', () => {
    // The filenames used to be the relative strings 'logs/combined.log' and
    // 'logs/error.log', which resolve against the working directory — so they only
    // landed in /app/logs because the old crontab entry did `cd /app` first.
    const target = path.join(tempRoot, 'logs');
    const logger = loadLogger(target);

    const transports = fileTransports(logger);
    expect(transports).toHaveLength(2);

    for (const transport of transports) {
      expect(path.isAbsolute(transport.dirname)).toBe(true);
      expect(transport.dirname).toBe(target);
    }

    expect(transports.map((transport) => transport.filename).sort()).toEqual([
      'combined.log',
      'error.log',
    ]);
  });

  it('keeps the error log at error level only', () => {
    const logger = loadLogger(path.join(tempRoot, 'logs'));

    const errorTransport = fileTransports(logger).find(
      (transport) => transport.filename === 'error.log'
    );
    expect(errorTransport.level).toBe('error');
  });

  it('defaults to a directory under the application root, not the working directory', () => {
    const logger = loadLogger(undefined);

    const expected = path.join(__dirname, '..', 'logs');
    for (const transport of fileTransports(logger)) {
      expect(transport.dirname).toBe(expected);
    }
  });

  it('degrades to console-only when the directory cannot be created', () => {
    // A read-only root filesystem with no logs volume is a misconfiguration to
    // report — not a reason to lose every message about it. Winston does not
    // create the directory itself: it emits ENOENT on the transport and drops the
    // write silently.
    const blocker = path.join(tempRoot, 'not-a-directory');
    fs.writeFileSync(blocker, '');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const logger = loadLogger(path.join(blocker, 'logs'));

      expect(fileTransports(logger)).toHaveLength(0);
      expect(logger.transports).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('File logging disabled'));
      expect(() => logger.info('still works')).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it('installs a single silent transport under NODE_ENV=test', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.GHOSTBUDGET_LOG_DIR = path.join(tempRoot, 'should-not-exist');

    built = require('../src/logger');

    expect(built.transports).toHaveLength(1);
    expect(built.transports[0].silent).toBe(true);
    expect(fs.existsSync(process.env.GHOSTBUDGET_LOG_DIR)).toBe(false);
  });
});

describe('logger format', () => {
  it('stamps a correlation id and the service metadata on every record', () => {
    const logger = require('../src/logger');

    expect(logger.defaultMeta).toMatchObject({ service: 'ghostbudget' });

    const record = logger.format.transform({ level: 'info', message: 'hello' });
    expect(record.correlationId).toBeTruthy();
    expect(record.timestamp).toBeTruthy();
  });
});
