const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateDataDir } = require('../src/utils/validation');

describe('validateDataDir', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbudget-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the resolved path for a writable directory', () => {
    expect(validateDataDir(tempDir)).toBe(path.resolve(tempDir));
  });

  it('normalizes a path containing traversal segments', () => {
    const nested = path.join(tempDir, 'a', '..', 'b');
    fs.mkdirSync(path.join(tempDir, 'b'));

    expect(validateDataDir(nested)).toBe(path.join(tempDir, 'b'));
  });

  it('treats unset as unset rather than as an error', () => {
    // The variable is optional in the environment schema, so an empty value must
    // not be turned into a startup failure.
    expect(validateDataDir(undefined)).toBeUndefined();
    expect(validateDataDir(null)).toBeUndefined();
    expect(validateDataDir('')).toBeUndefined();
  });

  it('rejects system directories', () => {
    // The old entrypoint ran `chown -R` against this value as root, so "/" meant
    // recursively rewriting ownership of the container filesystem.
    for (const protectedDir of ['/', '/etc', '/usr', '/var', '/root', '/proc']) {
      expect(() => validateDataDir(protectedDir)).toThrow(/must not be a system directory/);
    }
  });

  it('rejects a relative path', () => {
    expect(() => validateDataDir('data')).toThrow(/must be an absolute path/);
    expect(() => validateDataDir('./data')).toThrow(/must be an absolute path/);
  });

  it('rejects a non-string value', () => {
    expect(() => validateDataDir(42)).toThrow(/must be a string/);
    expect(() => validateDataDir({})).toThrow(/must be a string/);
  });

  it('rejects a directory that does not exist', () => {
    // The old shell guard silently skipped when the path was missing, and Actual
    // Budget then wrote to a path that was never persisted.
    expect(() => validateDataDir(path.join(tempDir, 'absent'))).toThrow(/does not exist/);
  });

  it('rejects a path that is a file', () => {
    const file = path.join(tempDir, 'a-file');
    fs.writeFileSync(file, '');

    expect(() => validateDataDir(file)).toThrow(/is not a directory/);
  });

  it('rejects a directory it cannot write to', () => {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      // Root bypasses the permission bits, so there is nothing to assert.
      return;
    }

    const locked = path.join(tempDir, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });

    try {
      expect(() => validateDataDir(locked)).toThrow(/is not readable and writable/);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});
