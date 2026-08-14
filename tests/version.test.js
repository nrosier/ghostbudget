const pkg = require('../package.json');
const build = require('../src/config/version');

const { describeBuild } = build;

// A real object name and a real timestamp, so the assertions read as the strings an
// operator would actually see in a log.
const COMMIT = '079da7b1c4e5f60718293a4b5c6d7e8f90123456';
const SHORT = '079da7b';
const BUILT_AT = '2026-08-14T14:00:04Z';

describe('build identity', () => {
  it('composes a version with the build time and the commit after the plus', () => {
    const described = describeBuild(
      { GHOSTBUDGET_COMMIT: COMMIT, GHOSTBUDGET_BUILT_AT: BUILT_AT },
      '1.0.0'
    );

    // SemVer 2.0.0 build metadata: dot-separated identifiers of [0-9A-Za-z-], which
    // is why the timestamp is in basic format. A colon here would make the whole
    // string invalid.
    expect(described.build).toBe('1.0.0+20260814T140004Z.079da7b');
    expect(described.version).toBe('1.0.0');
    expect(described.commit).toBe(SHORT);
    expect(described.revision).toBe(COMMIT);
    expect(described.builtAt).toBe(BUILT_AT);
    expect(described.dirty).toBe(false);
  });

  it('accepts a short commit as well as a full one', () => {
    const described = describeBuild({ GHOSTBUDGET_COMMIT: SHORT }, '1.0.0');

    expect(described.build).toBe('1.0.0+079da7b');
    expect(described.commit).toBe(SHORT);
    expect(described.revision).toBe(SHORT);
  });

  it('normalizes a timestamp with milliseconds, an offset, or upper-case hex', () => {
    const described = describeBuild(
      {
        GHOSTBUDGET_COMMIT: `  ${COMMIT.toUpperCase()}  `,
        GHOSTBUDGET_BUILT_AT: '2026-08-14T16:00:04.568+02:00',
      },
      '1.0.0'
    );

    // The output width is fixed by toISOString regardless of what came in, so an
    // environment variable cannot widen a log field.
    expect(described.builtAt).toBe(BUILT_AT);
    expect(described.build).toBe('1.0.0+20260814T140004Z.079da7b');
  });

  it('marks a build made from a dirty tree', () => {
    // `git describe --always --dirty` is what produces this, and it is the case
    // where the commit alone would be a lie: the code that ran is not that tree.
    const described = describeBuild({ GHOSTBUDGET_COMMIT: `${SHORT}-dirty` }, '1.0.0');

    expect(described.build).toBe('1.0.0+079da7b.dirty');
    expect(described.dirty).toBe(true);
    expect(described.meta).toEqual({ version: '1.0.0', commit: SHORT, dirty: true });
  });

  it('reports a dev build when nothing was stamped in', () => {
    const described = describeBuild({}, '1.0.0');

    expect(described.build).toBe('1.0.0+dev');
    expect(described.commit).toBeNull();
    expect(described.revision).toBeNull();
    expect(described.builtAt).toBeNull();
    expect(described.dirty).toBe(false);
  });

  it.each([
    ['not hex', 'zzzzzzz'],
    ['too short to be unambiguous', '079da7'],
    ['longer than an object name', COMMIT + '0'],
    ['a branch name', 'refs/heads/main'],
    ['an injected log field', '079da7b","level":"error'],
    ['not a string', 12345],
  ])('discards a commit that is %s', (_label, value) => {
    // A wrong commit is worse than an absent one: it names a specific tree the
    // running code did not come from.
    const described = describeBuild({ GHOSTBUDGET_COMMIT: value }, '1.0.0');

    expect(described.commit).toBeNull();
    expect(described.build).toBe('1.0.0+dev');
  });

  it.each([
    ['unparseable', 'yesterday afternoon'],
    ['empty', '   '],
    ['not a string', 1755180004],
  ])('discards a build time that is %s', (_label, value) => {
    const described = describeBuild(
      { GHOSTBUDGET_COMMIT: SHORT, GHOSTBUDGET_BUILT_AT: value },
      '1.0.0'
    );

    expect(described.builtAt).toBeNull();
    expect(described.build).toBe('1.0.0+079da7b');
  });

  it('keeps the commit out of the version string when only the time is known', () => {
    const described = describeBuild({ GHOSTBUDGET_BUILT_AT: BUILT_AT }, '1.0.0');

    expect(described.build).toBe('1.0.0+20260814T140004Z');
    expect(described.meta).toEqual({ version: '1.0.0' });
  });
});

describe('log field sets', () => {
  it('puts only the two shortest fields on every record', () => {
    // This job logs a record per account, so the build time is on the startup
    // record instead of all of them.
    const described = describeBuild(
      { GHOSTBUDGET_COMMIT: COMMIT, GHOSTBUDGET_BUILT_AT: BUILT_AT },
      '1.0.0'
    );

    expect(described.meta).toEqual({ version: '1.0.0', commit: SHORT });
    expect(described.startup).toEqual({
      build: '1.0.0+20260814T140004Z.079da7b',
      built_at: BUILT_AT,
    });
  });

  it('omits an unknown build time rather than recording it as null', () => {
    // So a query for "builds older than X" cannot match a run that never said.
    const described = describeBuild({ GHOSTBUDGET_COMMIT: SHORT }, '1.0.0');

    expect(described.startup).toEqual({ build: '1.0.0+079da7b' });
    expect(described.startup).not.toHaveProperty('built_at');
  });
});

describe('the module as loaded', () => {
  it('takes its version from package.json rather than a second copy', () => {
    expect(build.version).toBe(pkg.version);
    expect(build.build.startsWith(`${pkg.version}+`)).toBe(true);
  });

  it('is frozen, so nothing can restamp the build at runtime', () => {
    expect(Object.isFrozen(build)).toBe(true);
  });
});
