# Security Policy & Audit Report — GhostBudget

**Last Updated:** 2026-08-14
**Application Version:** 1.0.0
**Audit Version:** 3.3
**Overall Risk Level:** 🟢 **LOW**

---

## Executive Summary

GhostBudget is a one-shot CLI job that reads account balances from an
[Actual Budget](https://actualbudget.org/) server and writes them to matching
[Ghostfolio](https://ghostfol.io/) accounts. It has no long-running server, no
inbound network surface, and no user-facing HTTP endpoint — its only external
interactions are authenticated outbound calls to the two configured APIs.

This report documents the security posture of the current codebase. All
critical and high-severity findings from earlier audits have been resolved.
Audit logging and correlation IDs are implemented and verified in code. Rate
limiting and the circuit breaker were implemented and have since been **removed**
on the evidence that neither could function in a one-shot sequential process and
the breaker actively suppressed balance updates — see "Resilience & abuse
protection" below. The application is considered **production-ready** from a
security standpoint.

The threat this tool has to answer for is not primarily disclosure — it holds no
data of its own and has no inbound surface. It is **write integrity**: the one
thing it does to Ghostfolio is overwrite account balances, so a failure that
overwrites a correct balance with an incorrect one is more costly than a failure
that writes nothing. Audit 3.2 is the pass that took that seriously, and 3.3
corrected the one control in it that could not fire — the read-back compared
against a response field that does not exist — see "Write integrity" below. It
assumes nothing about the two services being co-located or trusted, because a
deployment that puts them on one Docker host is a convention, not a guarantee.

| Risk area            | Status |
| -------------------- | ------ |
| Credential exposure  | 🟢 LOW |
| Injection            | 🟢 LOW |
| Container security   | 🟢 LOW |
| Transport security   | 🟢 LOW |
| Write integrity      | 🟢 LOW |
| Operational security | 🟢 LOW |

---

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.
Instead:

1. Email the maintainers directly with:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - A suggested fix, if any
2. Allow up to 48 hours for an initial response.
3. Work with the maintainers on coordinated disclosure before any public
   announcement.

Security fixes are released as soon as practical after confirmation. Watch the
repository to stay informed.

---

## Design principles

The controls below are each individually justified, but they follow from a small
number of decisions about what this tool is. They are recorded here because a
reader who knows them can predict most of what follows, and because a change that
contradicts one of them is worth noticing.

1. **Refusing beats guessing, on every write path.** An ambiguous account name, a
   currency that disagrees, an all-zero read, a stored value that does not match
   what was sent — each of these ends in nothing being written rather than
   something plausible. The output of this tool is a number its operator will read
   as a bank balance, so an absent update is recoverable in a way a wrong one is
   not.
2. **Balance values appear nowhere but the request body.** Not in logs, not in
   audit records, not in error messages — which is why the guards name the account
   or the limit instead of the value. `error.log` sits on a mounted volume and
   outlives the process.
3. **One request in flight at a time.** The sync `await`s each account in turn.
   Sequential execution is a tighter bound than any limiter would impose, and it
   makes each account's failure independently attributable.
4. **Retry, and nothing above it.** Transient failures are worth retrying, on both
   legs; a shared-state control that can refuse requests on another account's
   behalf is not appropriate for a run this short. The wall-clock backstop is the
   scheduler's `SYNC_TIMEOUT_MS`, escalating `SIGTERM` to `SIGKILL`.
5. **The host decides the transport rule, not `NODE_ENV`.** Plaintext is refused
   wherever the traffic could leave a local network and accepted where it cannot.
   What determines the exposure is the host.
6. **Prefer the standard library.** `crypto.randomUUID()` over a UUID package —
   the same CSPRNG, one fewer dependency to install, audit and mock around.

Several controls that once appeared in this document have since been **removed**
rather than fixed, on the evidence that they could not function in a one-shot
sequential process: a circuit breaker, a rate limiter, response caching, batch
processing, and a generic API-response validator. The two that bear on the
security posture are covered under "Resilience & abuse protection" below; all of
them, with what each cost, are in [docs/decisions.md](docs/decisions.md).

---

## Security Controls Implemented

### Input & configuration validation ✅

- Joi schema validation for `config.json` account mappings (`validateConfig`)
  and environment variables (`validateEnvironment`) — see
  [src/utils/validation.js](src/utils/validation.js).
- **Plaintext HTTP is refused for any host outside a local network**, in every
  environment, for both `ACTUAL_BUDGET_URL` and `GHOSTFOLIO_URL`
  (`assertTransportSecurity`, `isPrivateHost` in
  [src/utils/validation.js](src/utils/validation.js)). See "Transport security"
  below for the host classification and why this replaced a `NODE_ENV` gate.
- **`config.json` mappings must be unambiguous.** `currency` is required, and
  `ghostfolioName` must be unique across the array (Joi `.unique()`, applied to
  the trimmed values, so `'Savings'` and `' Savings '` collide). Two mappings
  targeting one Ghostfolio account meant the second write silently overwrote the
  first and the run reported success.
- **Credential length minimums** are enforced at startup, so a placeholder or an
  empty-ish value fails fast instead of becoming a live credential:
  `ACTUAL_BUDGET_PASS` at least 8 characters, `GHOSTFOLIO_TOKEN` at least 16
  ([src/config/constants.js:137-138](src/config/constants.js#L137-L138)). The
  Ghostfolio token is a UUID in practice, so 16 is a floor that catches
  truncation and copy-paste errors rather than a policy for humans to satisfy.
- Balance, factor, and account-name validation (`validateBalance`,
  `validateFactor`, `validateAccountName`), plus response-shape checks at their
  point of use in `ghostfolio.js`. A generic `validateApiResponse(body, fields)`
  used to front those checks, but `field in body` is satisfied by a present-but-null
  `authToken` and by an `accounts` that is a string, so the specific check that
  always followed it was doing the work. `validateFactor` is separate from
  `validateBalance` on
  purpose: a factor of `0` is falsy and finite, so a single "is this a usable
  number" check accepted it and silently zeroed every balance it touched.
- Money is converted in minor units — `Math.round(cents * factor) / 100` — so a
  factor cannot produce a float artefact that reaches a financial API. Multiplying
  in units instead sent values like `1100.1320000000001` to be stored as a balance.
- A **magnitude bound** on balances (`MAX_BALANCE_MINOR_UNITS`): past it, the value
  is a corrupted read rather than a balance. The error names the limit, never the
  value that exceeded it.
- **Account ids from Ghostfolio are validated** before being interpolated into a
  request path (`validateAccountId`): a non-empty string, at most
  `MAX_ACCOUNT_ID_LENGTH` characters, `[A-Za-z0-9_-]` only, and
  `encodeURIComponent` on top of that. An id outside the set emits an
  `unexpected_account_id` security event and no request is sent.
- Defense-in-depth rejection of obviously malicious account names
  (`<script`, `javascript:`, `on*=`) at
  [src/utils/validation.js:198-206](src/utils/validation.js#L198-L206). Account
  names are treated as identifiers and serialized as JSON only — they are
  intentionally **not** HTML-escaped, so legitimate names containing
  `& < > " '` still match across both APIs. A rejected name emits an
  `xss_attempt` security audit event.

### Secure logging & error handling ✅

- Structured JSON logging via Winston with a per-process correlation ID
  ([src/logger.js](src/logger.js)); file transports rotate at 10 MB / 5 files.
  Log paths are absolute, anchored to the application root (or
  `GHOSTBUDGET_LOG_DIR`), and the directory is created `0750` at startup — a
  relative `logs/` path silently depended on the process's working directory.
- `sanitizeError()` strips stack traces, **redacts credentials that reached an
  error message**, and caps the message at 512 characters
  ([src/utils/validation.js](src/utils/validation.js)). Redaction is both
  value-based — the live values of `ACTUAL_BUDGET_PASS` and `GHOSTFOLIO_TOKEN` are
  replaced wherever they appear — and pattern-based, covering `Bearer` tokens,
  `token=`/`password=` query and form parameters, and credentials embedded in a
  URL's userinfo. A remote server that echoes a request back, or an error string
  built by concatenating a URL, would otherwise put a secret in the log file.
- **Balance values are never logged**, in any environment. This was previously
  conditional on `NODE_ENV`, which meant every non-production run wrote account
  balances to disk in plain text.
- Graceful shutdown on `SIGTERM`/`SIGINT` plus handlers for unhandled
  rejections and uncaught exceptions ([src/index.js](src/index.js)). Exit waits
  for Winston's transports to flush, so the failure reason and the audit event
  that records it survive the exit
  ([src/utils/exit.js](src/utils/exit.js)).

### Audit trail ✅

- [src/utils/audit.js](src/utils/audit.js) records authentication attempts,
  balance updates, sync start/complete/fail/skipped, security events (e.g. a
  rejected account name, a protected data directory), and validation failures.
  Every record carries winston's ISO timestamp and the per-process
  `correlationId`, which is what ties the events of one run together. Each payload
  used to carry a second ISO timestamp and its own `event_id` UUID as well; the
  timestamp duplicated winston's and nothing ever read the id, so both are gone —
  and the `uuid` dependency with them, since `crypto.randomUUID()` produces the
  correlation ID.
- **Every record identifies the build that wrote it**: `version` from
  `package.json` and the `commit` it was built from, with the full
  `1.0.0+20260814T140004Z.079da7b` and `built_at` on the startup record
  ([src/config/version.js](src/config/version.js)). `version` was previously the
  literal `'1.0.0'` in the logger, which could not distinguish two builds of one
  version — so a log establishing what the tool did could not establish which code
  did it. The commit and build time are stamped in at image build time, because
  `.dockerignore` excludes `.git/` and the image has no git binary. A value that is
  not a hex object name is discarded rather than recorded: an absent commit is a
  gap, a wrong one is a false attribution.
- Balance-update events record **whether the balance actually changed**, compared
  against the value Ghostfolio already held, and **whether a request was actually
  sent** (`written`, plus `dry_run` under `DRY_RUN`). `changed` was a hardcoded
  `true` for every account on every run, which made the audit trail useless for the
  one question it exists to answer: what did this job change?
- The completed-sync event records `mapped`, `resolved`, `changed`, `written`,
  `confirmed`, `unchanged` and `failed`, taken from the sync itself. It used to
  record `accounts_synced` as the length of the Actual Budget account list, so a
  budget with 20 accounts and two mappings audited a successful sync of 20 — and a
  dry run audited a successful sync of 20 while writing nothing. A partially failed
  run carries the same counts, so "3 of 5 stored" survives the failure.

### Write integrity ✅

The only field this tool writes is `balance`, on accounts named in `config.json`.
A wrong balance is worse than a stale one, so a run is arranged so that an error
leaves the previous value in place. See
[README](README.md#what-is-written-and-when-it-is-not) for the operator-facing
version.

- **Resolve everything, then write.** `syncAccountBalances` computes every intended
  write before sending the first one. Resolution used to be interleaved with
  writing, so the early accounts were already committed before the later ones had
  been looked at, and a check spanning the whole set could not exist.
- **`config.json` is read before authenticating**, so a local mistake does not
  exchange a credential first.
- **A run in which every mapped account resolves to zero writes nothing at all.** A
  single zero is a real balance and is written. All of them at once is what a budget
  that downloaded without applying its sync messages looks like, or a wrong
  `ACTUAL_BUDGET_SYNC_ID`. None of those raise an error, so every upstream guard
  passed and real balances were overwritten with zeros under a success report.
- **A name matching more than one account is refused, not resolved by picking.**
  This was `Array.prototype.find()` on both sides; neither system enforces unique
  account names, so the balance went to whichever account the API happened to list
  first, the other was never touched, and nothing said the name was ambiguous.
- **Currency is compared, never converted.** Neither API states the currency of an
  Actual Budget balance, so `config.json` declares it and it is checked against the
  Ghostfolio account. A mismatch fails that account and the rest of the run
  continues. Previously a balance in one currency was written verbatim into an
  account denominated in another, with no error and no warning.
- **Every write is read back.** After the writes, the account list is fetched a
  second time and each written balance compared with the one sent; a difference
  beyond `BALANCE_EPSILON` (half a cent) fails that account. An HTTP 2xx alone is a
  weaker claim than "the balance in Ghostfolio is the balance from Actual Budget".
  If the read-back cannot be made — the request fails, or an account is no longer in
  the list — the run reports `confirmed` below `written` rather than failing writes
  that were accepted or claiming a confirmation it does not have.

  This check previously compared against the balance in the **update** response,
  which cannot work and never did: `PUT /api/v1/account/:id` returns a Prisma
  `Account`, and that model has no `balance` column — balances are `AccountBalance`
  rows keyed by `(accountId, date)`, written separately. So the field was always
  absent, the comparison never ran, and every write logged "unconfirmed". The
  account list is the endpoint that carries `balance`, derived as the most recent
  non-future `AccountBalance` value. A check that cannot fire is worse than no
  check, because the log implies something was verified.

- **Unchanged balances are not rewritten.** Every write is an opportunity to store
  a wrong number. The PUT used to fire regardless of whether the value had moved.
- **One failure does not stop the rest.** Per-mapping errors are collected and the
  run exits non-zero with a count; the accounts that could be synced were.
- **`DRY_RUN=true`** resolves and reports every mapping without sending a write.

### Transport security ✅

- **Plaintext HTTP is rejected for any host that is not local**, in every
  environment, before the process starts — the credential in each URL's request
  would otherwise cross a network in the clear. `isPrivateHost` accepts
  `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, IPv6
  `::1` / `fc00::/7` / `fe80::/10`, `.local` and `.internal` names, and single-label
  hostnames (a Docker Compose service name such as `actual_server`). A rejected URL
  emits an `insecure_transport` security event at `high`.
- This replaced a rule conditional on `NODE_ENV=production`, which was wrong in
  both directions. Too strict for the deployment this project documents: the image
  sets `ENV NODE_ENV=production` ([Dockerfile](Dockerfile)), so
  `http://actual_server:5006` over the Compose network could not start, and
  `.env.example` as shipped could not start either. Too lax where it mattered: a run
  with `NODE_ENV` unset sent credentials in plaintext to any host on the internet
  without comment. The host is what determines the exposure, so the host is what is
  checked.
- Certificate validation enforced (`rejectUnauthorized: true`).
- TLS 1.2 minimum / TLS 1.3 maximum on the Ghostfolio agent
  ([src/ghostfolio.js](src/ghostfolio.js)).
- **A process-wide TLS floor** (`tls.DEFAULT_MIN_VERSION`) set by
  [src/config/tls.js](src/config/tls.js), which both service modules load. The
  agent options only cover the Ghostfolio leg: `@actual-app/api` opens its own
  connections, which no agent option of ours reaches, so the Actual Budget leg was
  previously free to negotiate TLS 1.0.
- **No cipher allowlist.** There was one, and it was worse than nothing: it
  permitted only `ECDHE-RSA` suites for TLS 1.2, which fails the handshake outright
  against a server holding an ECDSA certificate — what Let's Encrypt and Cloudflare
  both issue by default. Its TLS 1.3 entries were inert regardless, because Node's
  `ciphers` option governs TLS 1.2 and below only. Node's default suite list is
  maintained upstream and is the better choice here.
- 30 s request timeout and 10 MB content/body size limits to bound resource use
  ([src/config/constants.js](src/config/constants.js)).

### Resilience & abuse protection ✅

- **Retry with exponential backoff:** `axios-retry` retries network/idempotent
  errors and HTTP 429 up to `MAX_RETRIES` (default 3), with each delay capped at
  `MAX_RETRY_DELAY_MS` ([src/ghostfolio.js](src/ghostfolio.js)). This is the only
  resilience layer wrapped around the HTTP client, deliberately.
- **The read leg retries too.** `@actual-app/api` builds its own HTTP client, so
  `axios-retry` never covered it and a server that had not finished starting when the
  scheduled sync fired failed the whole run on the first attempt. The connect and the
  budget download now retry as one unit, `MAX_RETRIES` times, backing off from
  `RETRY_BASE_DELAY_MS` under the same `MAX_RETRY_DELAY_MS` cap
  ([src/actualBudget.js](src/actualBudget.js)). Retries are an **allowlist** of transient
  failures: a wrong password, an unwritable data directory or a malformed sync ID is
  permanent, so it still fails on the first attempt rather than being attempted four times
  against the server. Every attempt after the first starts from a full `shutdown()` —
  re-initializing on top of a half-open server session and SQLite handle is how a retry
  would turn a transient failure into corrupt local state.
- **An unreadable account costs only that account.** The balances used to be read with
  `Promise.all`, so one closed account returning a null balance, or one name that failed
  validation, rejected the whole batch and no account in the budget was synced. Each
  balance is now read and validated on its own and a failure skips that account. This is
  safe because a skipped account is _absent_ rather than wrong: the `config.json` mapping
  that names it fails to resolve, so the run still exits non-zero carrying that account's
  own reason, and nothing is written for it. If no account can be read the returned list
  is empty, which [src/index.js](src/index.js) refuses as a failed run rather than
  reporting a successful sync over nothing.
- **One request in flight at a time.** A sync `await`s each account in turn, so
  outbound concurrency is one, and a run makes roughly `2 + N` requests for `N`
  mapped accounts. There was a `rate-limiter-flexible` queue in front of this
  allowing 10 req/s; sequential execution is a tighter bound than the limit it
  enforced, so the queue never queued a request and has been removed.
- **No circuit breaker.** There was an `opossum` breaker here, opening at a 50%
  error rate over the shared request stream, and it cost more than it bought. On a
  run where authentication and the account fetch succeed and then some account
  `PUT`s fail — a couple of stale mappings — the third failure opened it, and every
  remaining account was then rejected locally without being sent, with its real
  Ghostfolio error replaced by "Breaker is open" in both the thrown summary and the
  audit trail. A few bad mappings became a wall in front of the accounts behind
  them. Its 30 s `resetTimeout` could not recover inside a one-shot sync either.
  The wall-clock backstop is the scheduler's `SYNC_TIMEOUT_MS`, which bounds the
  whole run and escalates SIGTERM to SIGKILL — a bound the breaker never provided.
- **Account updates are a bounded projection.** The update payload is built from
  the fields Ghostfolio's `UpdateAccountDto` accepts, not by spreading the fetched
  account. Ghostfolio's validation pipe runs with `forbidNonWhitelisted: true`, so a
  single extra property fails the whole request with a 400; the previous hand-built
  payload also omitted fields, and a `PUT` that omits a field resets it.

### Secrets management ✅

- Secrets (`ACTUAL_BUDGET_PASS`, `GHOSTFOLIO_TOKEN`) are read from environment
  variables only and are **never written to disk**. Nothing in the container
  copies the environment to a file; the sync process inherits it directly from
  the scheduler ([src/scheduler.js](src/scheduler.js)).
- The access token is held in memory during a run and never logged.
- `.env` and `config*.json` are excluded from the Docker build context
  ([.dockerignore](.dockerignore)), so a local `docker build` cannot bake real
  credentials into an image layer.
- Credentials that reach an error message are redacted before logging — see
  **Secure logging & error handling** above.

### Container security ✅

- Alpine base image for a minimal attack surface, **pinned by `sha256` digest**
  so a build of a given commit is reproducible and a mutated upstream tag cannot
  be pulled silently. Security updates are applied at build time
  ([Dockerfile](Dockerfile)).
- **No root at runtime.** `USER nodejs` (uid/gid 1001) is set in the image and
  the container has no root phase at all: the scheduler needs no privileges, so
  `cap_drop: [ALL]` and `no-new-privileges` are set in
  [docker-compose.yml](docker-compose.yml).
- **Application code is read-only to the runtime account.** `/app` is copied
  root-owned; only `/app/logs` and the data directory belong to `nodejs`, and the
  container root filesystem is mounted `read_only` with a small tmpfs at `/tmp`.
  A compromised sync cannot rewrite `src/` and persist across runs.
- Build toolchain removed after native-module compilation.
- **The image ships no package manager.** `npm`, `npx`, `corepack` and `yarn` are
  deleted in the same layer that used them, so the bytes never enter the image.
  Trivy scans the whole filesystem, and the npm bundled in `node:lts-alpine`
  vendors its own dependency tree — `tar`, `brace-expansion`, `ip-address` and
  `undici` there accounted for every fixable CRITICAL/HIGH finding in the image
  while the application's own production tree was clean. Nothing needs them at
  runtime: the entrypoint is `node`, the health check is `node`, and the scheduler
  forks `process.execPath`. A sync can still be run by hand with
  `docker exec <name> node src/index.js`.
- **Dependency install scripts are denied by default.** Installs run
  `npm ci --ignore-scripts`, and `better-sqlite3` is then rebuilt _by name_
  because `@actual-app/api` loads it natively. This applies to the image build, to
  CI, and to the `install:ci` / `install:prod` scripts in
  [package.json](package.json). Previously an `allowScripts` field named three
  permitted packages while every dependency in the tree ran its install scripts
  unimpeded: the field belongs to `@lavamoat/allow-scripts`, which was not
  installed, so nothing read it.
- `tini` is PID 1, so `SIGTERM` from `docker stop` is forwarded to the scheduler,
  which stops scheduling, gives an in-flight sync 8 s to finish, and exits.
- `CRON_TASK` is parsed by `croner` and constrained to a five-field expression or
  a known nickname ([src/scheduler.js](src/scheduler.js)). It is never
  interpolated into a shell command line, so command injection is not reachable
  by construction rather than by a character allowlist.
- `ACTUAL_BUDGET_DATA_DIR` is validated at startup — absolute, not a system
  directory, existing and writable — and no longer passed to a recursive `chown`
  running as root ([src/utils/validation.js](src/utils/validation.js)).
- The health check verifies the scheduler is alive and still ticking, via a
  heartbeat it refreshes on a timer ([src/healthcheck.js](src/healthcheck.js)).
  A failed sync is deliberately not unhealthy: restarting the container cannot
  fix a remote outage, and doing so would convert someone else's downtime into a
  crash loop.
- Resource limits (CPU, memory) and `stop_grace_period` are set in
  [docker-compose.yml](docker-compose.yml). No ports are exposed — this is a
  scheduled job, not a server.

### CI/CD security ✅

Defined in [.github/workflows/security.yml](.github/workflows/security.yml),
running on push, pull request, and a daily schedule:

- `npm audit` (moderate, advisory) plus a **blocking** `npm audit --omit=dev
--audit-level=high`. The `--omit=dev` matters: a dev-only advisory previously
  failed the production gate, which is the kind of noise that gets a gate disabled.
- Dependency review on pull requests (`fail-on-severity: moderate`).
- **ESLint with `eslint-plugin-security` actually registered.** The plugin was a
  dependency and appeared in this document, but it was never added to
  [eslint.config.js](eslint.config.js), so none of its 14 rules ran. `npm run lint`
  now also uses `--max-warnings=0`, so a finding fails the build rather than
  scrolling past.
- **Trivy image scan that can fail the build.** Results are uploaded to GitHub
  Security (unconditionally, via `if: always()`), and a second Trivy step then
  gates on fixable CRITICAL/HIGH findings (`exit-code: 1`, `ignore-unfixed: true`).
  The scan step itself must not be the gate, or a failing scan skips its own SARIF
  upload and the finding never reaches the Security tab.
- **Images are scanned before they are pushed.**
  [docker-image.yml](.github/workflows/docker-image.yml) builds with `load: true,
push: false`, scans the loaded image, and only then logs in to the registry and
  pushes. Registry login is deliberately deferred until after all third-party code
  has run.
- All third-party actions are **pinned to a commit SHA**, not a moving tag.
- TruffleHog secret scanning.
- Test coverage thresholds are enforced in CI
  ([jest.config.js](jest.config.js), [test.yml](.github/workflows/test.yml)). The
  CI job runs `npm run test:coverage` rather than `npm test`, because Jest's
  thresholds only engage when coverage is collected.

---

## OWASP Top 10 (2021) Assessment

| Category                                     | Status     | Notes                                                                                                                |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| A01 Broken Access Control                    | ✅ PASS    | Minimal access model; no multi-user surface.                                                                         |
| A02 Cryptographic Failures                   | ✅ PASS    | Secrets kept out of disk/logs; HTTPS + cert validation enforced.                                                     |
| A03 Injection                                | ✅ PASS    | Joi validation on all inputs; cron expression validated.                                                             |
| A04 Insecure Design                          | ✅ PASS    | Resolve-then-write ordering, read-back verification, bounded retries, hard sync timeout, audit trail.                |
| A05 Security Misconfiguration                | ✅ PASS    | Secure defaults; non-root execution; plaintext HTTP refused for non-local hosts.                                     |
| A06 Vulnerable & Outdated Components         | ✅ PASS    | Dependencies current; `npm audit` reports 0 vulnerabilities; blocking high-severity gate in CI.                      |
| A07 Identification & Authentication Failures | 🟡 PARTIAL | Token auth with audit logging and length minimums; no token expiry/refresh (see below).                              |
| A08 Software & Data Integrity Failures       | 🟡 PARTIAL | Base image pinned by digest; actions pinned by SHA; install scripts denied by default. No SBOM or image signing yet. |
| A09 Security Logging & Monitoring Failures   | ✅ PASS    | Structured, sanitized logs with correlation IDs and audit events.                                                    |
| A10 Server-Side Request Forgery (SSRF)       | ✅ PASS    | URL scheme/host validation; HTTPS required for every non-local host.                                                 |

**Score: 8 / 10 PASS** (2 partial, no failures).

---

## Dependency Security

`npm audit` reports **0 known vulnerabilities**, and `npm audit signatures` verifies a
registry signature for every package in the installed tree. Production dependencies are
kept current by Renovate:

| Package           | Version |
| ----------------- | ------- |
| `@actual-app/api` | 26.8.1  |
| `axios`           | 1.19.0  |
| `axios-retry`     | 4.5.0   |
| `croner`          | 10.0.1  |
| `dotenv`          | 17.4.2  |
| `joi`             | 18.2.3  |
| `winston`         | 3.19.0  |

Every version is exact rather than a `^` range, and `renovate.json` sets
`rangeStrategy: pin` so it stays that way. With a committed lockfile this changes nothing
about what `npm ci` installs; what it changes is that an upgrade cannot arrive as a side
effect of someone running `npm install`. Each one is a reviewed PR, which is the posture
this repository takes with a process that moves account balances.

[renovate.json](renovate.json) watches three ecosystems, because three separate things
reach production: `npm`, `github-actions` (workflow code runs in CI with that job's
scopes, including the job that holds the registry credentials) and `dockerfile` (the
base-image digest _is_ the deployed artifact). Only npm updates are eligible for
auto-merge, and only patch-level updates of direct dependencies at that; actions and the
digest carry an explicit `automerge: false` rather than relying on no rule having matched
them. `platformAutomerge` hands the merge to GitHub, so the required lint, test and
security checks still gate it.

Renovate is the only dependency bot on this repository, and that is the point rather than
a convenience. It replaced `.github/dependabot.yml` because two bots watching the same
manifests open two PRs per update; it then replaced Dependabot's **security** updates as
well, because keeping those meant keeping
`.github/workflows/dependabot-auto-merge.yml` — a `pull_request_target` workflow holding
`contents: write` and `pull-requests: write` in order to merge them. Renovate's
`platformAutomerge` hands the merge to GitHub instead, so it needs no workflow and no
elevated token. Deleting a privileged workflow is worth more here than the integration
was, and the auto-merge policy it enforced survives intact in
[renovate.json](renovate.json): patch updates to direct npm dependencies only, with
`automerge: false` stated explicitly on the `dockerfile` and `github-actions` managers
rather than left to the absence of a matching rule.

**Dependabot security updates must be turned off** in Settings → Code security, or every
security PR arrives twice. Nothing auto-merges a Dependabot PR any more, so leaving them
on is noisy rather than dangerous.

Two controls Renovate adds that Dependabot had no equivalent for:

- `minimumReleaseAge` holds a new npm release for three days before offering it. The npm
  supply-chain pattern this defends against is a compromised version that is published,
  installed by whatever updates within the hour, and yanked the same day. The hold is
  lifted for `vulnerabilityAlerts`, which exist to fix old versions rather than to adopt
  new ones — a known-exploitable dependency is not something to sit on until Monday.
- `osvVulnerabilityAlerts` widens vulnerability detection beyond GitHub's own advisory
  database, and `transitiveRemediation` lets a fix land as a lockfile-only bump when the
  vulnerable package is not a direct dependency. Security PRs are never auto-merged: a
  security fix is frequently a minor or major bump, which is exactly the shape this
  repository reviews by hand.

`opossum`, `rate-limiter-flexible` and `uuid` were direct production dependencies
and no longer are — the first two because the controls they provided could not
function here (see "Resilience & abuse protection"), and `uuid` because
`crypto.randomUUID()` is in the standard library.

`opossum` and `rate-limiter-flexible` are gone from `package-lock.json` outright,
so their code is no longer installed or scanned. `uuid` is a different case and
worth stating precisely: `@actual-app/api` depends on it, so it remains in the tree
transitively and still appears to a scanner. Dropping it removed a version this
project pinned and had to mock around in Jest, not a package from the image.

---

## Known Security Considerations

### Secrets in environment variables

Configuration is supplied via environment variables. Be aware that env vars are
visible via `docker inspect`, may appear in process listings, and are inherited
by child processes.

**Mitigation:** In production, prefer Docker secrets or an external secret
manager (HashiCorp Vault, AWS Secrets Manager) over `.env` files. Secrets are
never persisted to disk by the application itself.

### API token lifecycle

The Ghostfolio access token is held in memory for the duration of a single run
and cleared on exit. There is no automatic token expiration or refresh
(tracked as a future enhancement).

**Best practice:** Rotate access tokens regularly (at least every 90 days) and
scope them to the minimum permissions required.

### Base image pinning

The [Dockerfile](Dockerfile) pins `node:lts-alpine` to a `sha256` digest. This makes
builds reproducible, but it also means base-image security updates are **not** picked up
by the tag moving: the digest has to be refreshed deliberately. Two things drive that.
Trivy runs daily in CI against the built image, which surfaces the need; and
[renovate.json](renovate.json) watches the `dockerfile` manager, which opens the PR that
does it. The Dockerfile also records the command that resolves a new digest by hand.

A digest bump is never auto-merged, whatever its semver classification — the digest is
the deployed artifact, so a person reviews it. The bot rewrites the digest but not the
comment above it, which records the Node and Alpine versions it resolved to; re-resolve
those when reviewing the PR.

### What logs do and do not contain

Logs **may** contain account names (treated as non-sensitive identifiers), sync
status, errors, and API endpoint URLs. Logs **do not** contain passwords,
access tokens, account balances, or stack traces — and this holds in every
environment, not only when `NODE_ENV=production`.

That covers error messages too, which is why the balance guards report the limit
rather than the value: "magnitude exceeds N minor units" names a constant,
"stored a different balance than was sent for account X" names neither the value
sent nor the value found. An error message ends up in `error.log` on a mounted
volume like any other line, so a guard that quoted the balance it rejected would
put balances in the log file by a side door.

Credential redaction in `sanitizeError()` is defence in depth, not a licence to
put secrets in messages. It removes the known secret values and the common
patterns that carry them; a credential the application never learned the value of
(a third-party token echoed back inside a JSON error body, say) is not something
value-based redaction can find. Treat log files as sensitive and restrict access
to them accordingly.

---

## Remaining Improvements (Low Priority)

1. **Token lifecycle management** — expiration checks and refresh handling.
2. **Supply-chain hardening** — sign the container image. Cosign needs OIDC setup and a
   key-retention policy, which is a decision rather than a patch, so it is still open.
   (Base-image digest pinning, restricting auto-merge to patch-level updates of direct
   **npm** dependencies, automated update coverage of the `dockerfile` and
   `github-actions` ecosystems, a three-day `minimumReleaseAge` on npm releases, and a
   CycloneDX SBOM published per build are done — see
   [docker-image.yml](.github/workflows/docker-image.yml). The SBOM is generated from the
   same local image the pre-push Trivy gate passed, so what is inventoried is what ships
   and a rejected image never gets one.)
3. **Enhanced monitoring** — metrics/alerting on repeated auth failures and
   suspicious activity; optional syslog/HTTP log transport.
4. **Expanded security testing** — integration/fuzz tests and SAST (e.g. Snyk,
   SonarQube) in addition to the current ESLint + `eslint-plugin-security` +
   `npm audit` + Trivy pipeline.
5. **Egress restriction** — the container can currently reach any host. A network
   policy limiting egress to the two configured API hosts is listed in the
   deployment checklist below but is not something the image can enforce itself.

None of these are blocking; they can be delivered post-launch without material
security risk.

---

## Deployment Security Checklist

Items marked ✅ are enforced by the image or by
[docker-compose.yml](docker-compose.yml) and need no per-deployment action. The
rest are the operator's responsibility.

- ✅ The container runs as the non-root `nodejs` user (uid 1001), with
  `cap_drop: [ALL]`, `no-new-privileges`, and a read-only root filesystem.
- ✅ The base image is pinned to a `sha256` digest, not a tag.
- ✅ Resource limits (CPU, memory) are configured.
- ✅ The health check verifies the scheduler is actually running.
- ✅ Dependency install scripts are denied by default at image build time.
- ✅ A minimum TLS version is enforced process-wide, covering both API legs.
- ✅ Plaintext HTTP is refused for both API endpoints unless the host is one only a
  local network can reach.
- ✅ A run in which every mapped account reads zero writes nothing, and every write
  is read back — in a separate request, once the writes are done — and compared
  against the value that was sent. `confirmed` below `written` in the logs means
  those balances were accepted but not verified; it is worth a look, not an alarm.
- [ ] Secrets are stored in a secret manager, not committed `.env` files.
- [ ] `ACTUAL_BUDGET_PASS` and `GHOSTFOLIO_TOKEN` are real credentials, not
      placeholders — the 8- and 16-character minimums catch empty and truncated
      values, not weak ones.
- [ ] Every mapping in `config.json` declares the currency its Ghostfolio account
      is actually denominated in, and maps a cash account rather than a brokerage
      total (a Ghostfolio `balance` is cash; holdings are counted separately).
- [ ] One `DRY_RUN=true` run has been made after the last `config.json` edit.
- [ ] The published image tag in `docker-compose.yml` is the one you intend to run.
      It ships as `:latest`, so a restart rolls out whatever CI published most
      recently. To pin, use the commit tag — `niqck/ghostbudget:<full 40-char SHA>`
      — which is the only other tag published; `docker inspect` reports it as
      `org.opencontainers.image.revision`.
- [ ] Logs are aggregated and monitored.
- [ ] Access tokens have been rotated and scoped to least privilege.
- [ ] Network policies restrict container egress to the two API hosts.
- [ ] `npm audit` and the CI security workflow pass.
- [ ] The data volume is backed up, and restores have been tested.

---

## Related documents

- [README.md](README.md) — installation, configuration, and the operator-facing
  version of [what is written and when it is not](README.md#what-is-written-and-when-it-is-not).
- [docs/decisions.md](docs/decisions.md) — why the code has the shape it has, in the
  cases where that shape was arrived at by removing or replacing something that did
  not work. The rule each entry produced lives in the code; this is the reasoning
  behind it, so a future change knows what it is undoing.
- [docs/history/audit-2026-08-13.md](docs/history/audit-2026-08-13.md) — the archived
  audit that produced most of the hardening in this document. Point-in-time: its line
  numbers refer to a commit that no longer matches the tree.

---

## References

- [OWASP Top 10](https://owasp.org/Top10/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)
- [OpenSSF Best Practices](https://www.bestpractices.dev/)
