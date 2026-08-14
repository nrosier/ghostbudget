const { version } = require('../../package.json');

/**
 * Build identity: which commit this is, and when the image carrying it was built.
 *
 * The format is SemVer 2.0.0 build metadata — `1.0.0+20260814T140004Z.079da7b`. The
 * part after `+` is defined by the spec as metadata that carries no precedence, so
 * every semver-aware tool still reads this as plain `1.0.0` while the string itself
 * says exactly what is running.
 *
 * The timestamp is in ISO 8601 *basic* format on purpose. Build metadata is
 * dot-separated identifiers of `[0-9A-Za-z-]` only, so the colons in
 * `14:00:04` would make the string invalid; `built_at` keeps the extended format,
 * where there is no such restriction.
 *
 * Both inputs arrive as environment variables because they cannot be derived at
 * runtime: `.dockerignore` excludes `.git/`, and the image has no git binary — the
 * Dockerfile deletes even the package managers. So the build stamps them in, and a
 * run with neither set reports `1.0.0+dev` rather than inventing a commit.
 */

// Short form for reading, full form for the OCI `revision` label. Seven is what git
// itself abbreviates to, and is unambiguous well past this repository's size.
const SHORT_COMMIT_LENGTH = 7;

// A commit, optionally marked dirty by `git describe --always --dirty`. Anchored and
// length-bounded because whatever matches ends up on every log line: an unbounded
// environment variable must not become an unbounded log field.
const COMMIT_PATTERN = /^([0-9a-f]{7,40})(?:[-+.]dirty)?$/i;

/**
 * Read a commit out of the environment, or nothing at all.
 *
 * Anything that is not a hex object name is discarded rather than passed through.
 * A wrong commit is worse than an absent one: it names a specific tree that the
 * running code did not come from.
 *
 * @param {string|undefined} raw - Candidate commit, possibly with a dirty marker
 * @returns {{full: string, short: string, dirty: boolean}|null} Parsed commit, or null
 */
function parseCommit(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const match = COMMIT_PATTERN.exec(raw.trim());

  if (!match) {
    return null;
  }

  const full = match[1].toLowerCase();

  return {
    full,
    short: full.slice(0, SHORT_COMMIT_LENGTH),
    dirty: match[0].length > full.length,
  };
}

/**
 * Read a build time out of the environment and normalize it.
 *
 * The output is derived from `Date.prototype.toISOString`, so its width is fixed no
 * matter what came in, and an unparseable value yields nothing instead of appearing
 * in a log field verbatim.
 *
 * @param {string|undefined} raw - Candidate timestamp in any format Date accepts
 * @returns {{extended: string, basic: string}|null} Both ISO 8601 forms, or null
 */
function parseBuiltAt(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const parsed = new Date(raw.trim());

  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  // Seconds are enough to identify a build, and dropping the milliseconds keeps the
  // basic form to the 16 characters a reader can scan.
  const extended = parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');

  return { extended, basic: extended.replace(/[-:]/g, '') };
}

/**
 * Describe the running build from an environment.
 *
 * Takes its inputs as arguments rather than reading `process.env` and `package.json`
 * directly, so the composition of the version string is testable without reloading
 * the module for every case.
 *
 * @param {Object} env - Environment to read GHOSTBUDGET_COMMIT and GHOSTBUDGET_BUILT_AT from
 * @param {string} packageVersion - The `version` field of package.json
 * @returns {Object} `build` (the full string), `builtAt`, `commit`, `dirty`, and the
 *   prepared `meta` and `startup` log field sets
 */
function describeBuild(env, packageVersion) {
  const commit = parseCommit(env.GHOSTBUDGET_COMMIT);
  const builtAt = parseBuiltAt(env.GHOSTBUDGET_BUILT_AT);

  const identifiers = [];

  if (builtAt) {
    identifiers.push(builtAt.basic);
  }

  if (commit) {
    identifiers.push(commit.short);
  }

  if (commit?.dirty) {
    identifiers.push('dirty');
  }

  // `+dev` for a run with nothing stamped in — a bare `npm run sync`, or a local
  // `docker build` with no build args. It reads as what it is instead of implying
  // that 1.0.0 came from a release.
  const build = `${packageVersion}+${identifiers.length > 0 ? identifiers.join('.') : 'dev'}`;

  return {
    version: packageVersion,
    build,
    commit: commit?.short ?? null,
    revision: commit?.full ?? null,
    dirty: commit?.dirty ?? false,
    builtAt: builtAt?.extended ?? null,

    // Stamped on every log and audit record, so any single line says which build
    // wrote it. Deliberately the two shortest fields: this job logs a record per
    // account, and the build time is on the startup record instead.
    meta: {
      version: packageVersion,
      ...(commit ? { commit: commit.short } : {}),
      // Only when true. A dirty build is a local one whose commit does not describe
      // the code that ran, which is worth saying out loud rather than leaving to be
      // inferred from a `false` on every line.
      ...(commit?.dirty ? { dirty: true } : {}),
    },

    // Logged once per process, on the record each entry point already writes at
    // startup. `built_at` is absent rather than null when unknown, so a query for
    // "builds older than X" cannot match a run that never said.
    startup: {
      build,
      ...(builtAt ? { built_at: builtAt.extended } : {}),
    },
  };
}

module.exports = Object.freeze({
  ...describeBuild(process.env, version),
  describeBuild,
});
