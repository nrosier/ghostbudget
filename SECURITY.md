# Security Policy & Audit Report — GhostBudget

**Last Updated:** 2026-08-13
**Application Version:** 1.0.0
**Audit Version:** 3.1
**Overall Risk Level:** 🟢 **LOW**

---

## Executive Summary

GhostBudget is a one-shot CLI job that reads account balances from an
[Actual Budget](https://actualbudget.org/) server and writes them to matching
[Ghostfolio](https://ghostfol.io/) accounts. It has no long-running server, no
inbound network surface, and no user-facing HTTP endpoint — its only external
interactions are authenticated outbound calls to the two configured APIs.

This report documents the security posture of the current codebase. All
critical and high-severity findings from earlier audits have been resolved, and
the controls that were previously listed as "planned" (rate limiting, circuit
breaker, audit logging, correlation IDs) are now implemented and verified in
code. The application is considered **production-ready** from a security
standpoint.

| Risk area            | Status |
| -------------------- | ------ |
| Credential exposure  | 🟢 LOW |
| Injection            | 🟢 LOW |
| Container security   | 🟢 LOW |
| Transport security   | 🟢 LOW |
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

## Security Controls Implemented

### Input & configuration validation ✅

- Joi schema validation for `config.json` account mappings (`validateConfig`)
  and environment variables (`validateEnvironment`) — see
  [src/utils/validation.js](src/utils/validation.js).
- URL scheme/host validation plus an **HTTPS requirement in production** for
  both `ACTUAL_BUDGET_URL` and `GHOSTFOLIO_URL`
  ([src/utils/validation.js](src/utils/validation.js)).
- **Credential length minimums** are enforced at startup, so a placeholder or an
  empty-ish value fails fast instead of becoming a live credential:
  `ACTUAL_BUDGET_PASS` at least 8 characters, `GHOSTFOLIO_TOKEN` at least 16
  ([src/config/constants.js:137-138](src/config/constants.js#L137-L138)). The
  Ghostfolio token is a UUID in practice, so 16 is a floor that catches
  truncation and copy-paste errors rather than a policy for humans to satisfy.
- Balance, factor, account-name, and API-response validation
  (`validateBalance`, `validateFactor`, `validateAccountName`,
  `validateApiResponse`). `validateFactor` is separate from `validateBalance` on
  purpose: a factor of `0` is falsy and finite, so a single "is this a usable
  number" check accepted it and silently zeroed every balance it touched.
- Money is converted in minor units — `Math.round(cents * factor) / 100` — so a
  factor cannot produce a float artefact that reaches a financial API. Multiplying
  in units instead sent values like `1100.1320000000001` to be stored as a balance.
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
  balance updates, sync start/complete/fail, security events (e.g.
  circuit-breaker open, XSS attempt), and validation failures — each stamped
  with a unique `event_id` and ISO timestamp.
- Balance-update events record **whether the balance actually changed**, compared
  against the value Ghostfolio already held. This was a hardcoded `true` for every
  account on every run, which made the audit trail useless for the one question it
  exists to answer: what did this job change?

### Transport security ✅

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

- **Rate limiting:** `rate-limiter-flexible` throttles outbound calls to 10
  req/s ([src/ghostfolio.js](src/ghostfolio.js)).
- **Circuit breaker:** `opossum` opens at a 50% error rate and logs a
  high-severity audit event on open ([src/ghostfolio.js](src/ghostfolio.js)). Its
  timeout is derived from the retry budget rather than fixed, so the breaker cannot
  trip on a request that is still legitimately retrying underneath it.
- **Retry with exponential backoff:** `axios-retry` retries network/idempotent
  errors and HTTP 429 up to `MAX_RETRIES` (default 3), with each delay capped at
  `MAX_RETRY_DELAY_MS` ([src/ghostfolio.js](src/ghostfolio.js)).
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
| A04 Insecure Design                          | ✅ PASS    | Rate limiting, circuit breaker, and audit trail in place.                                                            |
| A05 Security Misconfiguration                | ✅ PASS    | Secure defaults; non-root execution; HTTPS forced in production.                                                     |
| A06 Vulnerable & Outdated Components         | ✅ PASS    | Dependencies current; `npm audit` reports 0 vulnerabilities; blocking high-severity gate in CI.                      |
| A07 Identification & Authentication Failures | 🟡 PARTIAL | Token auth with audit logging and length minimums; no token expiry/refresh (see below).                              |
| A08 Software & Data Integrity Failures       | 🟡 PARTIAL | Base image pinned by digest; actions pinned by SHA; install scripts denied by default. No SBOM or image signing yet. |
| A09 Security Logging & Monitoring Failures   | ✅ PASS    | Structured, sanitized logs with correlation IDs and audit events.                                                    |
| A10 Server-Side Request Forgery (SSRF)       | ✅ PASS    | URL scheme/host validation; HTTPS enforced in production.                                                            |

**Score: 8 / 10 PASS** (2 partial, no failures).

---

## Dependency Security

`npm audit` reports **0 known vulnerabilities**. Production dependencies are
kept current (managed via Dependabot):

| Package                 | Version |
| ----------------------- | ------- |
| `@actual-app/api`       | ^26.7.0 |
| `axios`                 | 1.19.0  |
| `axios-retry`           | ^4.5.0  |
| `dotenv`                | 17.4.2  |
| `joi`                   | 18.2.3  |
| `opossum`               | ^10.0.0 |
| `rate-limiter-flexible` | ^11.2.0 |
| `uuid`                  | ^14.0.1 |
| `winston`               | 3.19.0  |

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

The [Dockerfile](Dockerfile) pins `node:lts-alpine` to a `sha256` digest. This
makes builds reproducible, but it also means base-image security updates are
**not** picked up automatically: the digest has to be refreshed deliberately. The
Dockerfile records the command that resolves a new one. Trivy runs daily in CI
against the built image, which is what surfaces the need to update.

### What logs do and do not contain

Logs **may** contain account names (treated as non-sensitive identifiers), sync
status, errors, and API endpoint URLs. Logs **do not** contain passwords,
access tokens, account balances, or stack traces — and this holds in every
environment, not only when `NODE_ENV=production`.

Credential redaction in `sanitizeError()` is defence in depth, not a licence to
put secrets in messages. It removes the known secret values and the common
patterns that carry them; a credential the application never learned the value of
(a third-party token echoed back inside a JSON error body, say) is not something
value-based redaction can find. Treat log files as sensitive and restrict access
to them accordingly.

---

## Remaining Improvements (Low Priority)

1. **Token lifecycle management** — expiration checks and refresh handling.
2. **Supply-chain hardening** — generate an SBOM and sign the container image.
   (Base-image digest pinning and restricting Dependabot auto-merge to
   patch-level updates of direct dependencies are done.)
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
- [ ] Secrets are stored in a secret manager, not committed `.env` files.
- [ ] `ACTUAL_BUDGET_PASS` and `GHOSTFOLIO_TOKEN` are real credentials, not
      placeholders — the 8- and 16-character minimums catch empty and truncated
      values, not weak ones.
- [ ] HTTPS is enforced for both API endpoints (required in production).
- [ ] The published image tag in `docker-compose.yml` is the one you intend to
      run (it is pinned to a release, not `latest` — bump it deliberately).
- [ ] Logs are aggregated and monitored.
- [ ] Access tokens have been rotated and scoped to least privilege.
- [ ] Network policies restrict container egress to the two API hosts.
- [ ] `npm audit` and the CI security workflow pass.
- [ ] The data volume is backed up, and restores have been tested.

---

## References

- [OWASP Top 10](https://owasp.org/Top10/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)
- [OpenSSF Best Practices](https://www.bestpractices.dev/)
