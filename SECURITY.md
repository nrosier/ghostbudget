# Security Policy & Audit Report — GhostBudget

**Last Updated:** 2026-07-31
**Application Version:** 1.0.0
**Audit Version:** 3.0
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

| Risk area                 | Status  |
| ------------------------- | ------- |
| Credential exposure       | 🟢 LOW  |
| Injection                 | 🟢 LOW  |
| Container security         | 🟢 LOW  |
| Transport security         | 🟢 LOW  |
| Operational security       | 🟢 LOW  |

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
  ([src/utils/validation.js:87-94](src/utils/validation.js#L87-L94)).
- Balance, account-name, and API-response validation
  (`validateBalance`, `validateAccountName`, `validateApiResponse`).
- Defense-in-depth rejection of obviously malicious account names
  (`<script`, `javascript:`, `on*=`) at
  [src/utils/validation.js:135-143](src/utils/validation.js#L135-L143). Account
  names are treated as identifiers and serialized as JSON only — they are
  intentionally **not** HTML-escaped, so legitimate names containing
  `& < > " '` still match across both APIs. A rejected name emits an
  `xss_attempt` security audit event.

### Secure logging & error handling ✅

- Structured JSON logging via Winston with a per-process correlation ID
  ([src/logger.js](src/logger.js)); file transports rotate at 10 MB / 5 files.
- `sanitizeError()` strips stack traces and other potentially sensitive fields
  before anything is logged
  ([src/utils/validation.js:153-160](src/utils/validation.js#L153-L160)).
- Balance values are not logged (debug logging deliberately omits them —
  [src/ghostfolio.js:206-209](src/ghostfolio.js#L206-L209)).
- Graceful shutdown on `SIGTERM`/`SIGINT` plus handlers for unhandled
  rejections and uncaught exceptions ([src/index.js](src/index.js)).

### Audit trail ✅

- [src/utils/audit.js](src/utils/audit.js) records authentication attempts,
  balance updates, sync start/complete/fail, security events (e.g.
  circuit-breaker open, XSS attempt), and validation failures — each stamped
  with a unique `event_id` and ISO timestamp.

### Transport security ✅

- Certificate validation enforced (`rejectUnauthorized: true`).
- TLS 1.2 minimum / TLS 1.3 maximum with a pinned cipher suite and
  `honorCipherOrder` ([src/ghostfolio.js:44-56](src/ghostfolio.js#L44-L56)).
- 30 s request timeout and 10 MB content/body size limits to bound resource use
  ([src/config/constants.js](src/config/constants.js)).

### Resilience & abuse protection ✅

- **Rate limiting:** `rate-limiter-flexible` throttles outbound calls to 10
  req/s ([src/ghostfolio.js:34-37](src/ghostfolio.js#L34-L37)).
- **Circuit breaker:** `opossum` opens at a 50% error rate (30 s timeout / 30 s
  reset) and logs a high-severity audit event on open
  ([src/ghostfolio.js:76-95](src/ghostfolio.js#L76-L95)).
- **Retry with exponential backoff:** `axios-retry` retries network/idempotent
  errors and HTTP 429 up to `MAX_RETRIES` (default 3)
  ([src/ghostfolio.js:59-73](src/ghostfolio.js#L59-L73)).

### Secrets management ✅

- Secrets (`ACTUAL_BUDGET_PASS`, `GHOSTFOLIO_TOKEN`) are read from environment
  variables only and are **never written to disk**. The container
  [entrypoint.sh](entrypoint.sh) writes only non-sensitive variables to
  `/app/project_env.sh` (mode `600`, owned by the `nodejs` user).
- The access token is held in memory during a run and never logged.

### Container security ✅

- Alpine base image for a minimal attack surface, with security updates applied
  at build time ([Dockerfile](Dockerfile)).
- Dedicated non-root user (`nodejs`, uid/gid 1001); build toolchain removed
  after native-module compilation; `npm ci --omit=dev` for reproducible,
  production-only installs.
- The container starts as root only to configure cron, then
  [entrypoint.sh](entrypoint.sh) drops privileges and runs the sync as the
  `nodejs` user.
- `CRON_TASK` is regex-validated to prevent command injection
  ([entrypoint.sh](entrypoint.sh)).
- Health check configured; no ports exposed (this is a scheduled job, not a
  server).

### CI/CD security ✅

Defined in [.github/workflows/security.yml](.github/workflows/security.yml),
running on push, pull request, and a daily schedule:

- `npm audit` (moderate) and a blocking production `npm audit` (high).
- Dependency review on pull requests (`fail-on-severity: moderate`).
- ESLint with `eslint-plugin-security`.
- Trivy container image scan (CRITICAL/HIGH) with results uploaded to GitHub
  Security.
- TruffleHog secret scanning.

---

## OWASP Top 10 (2021) Assessment

| Category                                   | Status | Notes                                                             |
| ------------------------------------------ | ------ | ----------------------------------------------------------------- |
| A01 Broken Access Control                  | ✅ PASS | Minimal access model; no multi-user surface.                      |
| A02 Cryptographic Failures                 | ✅ PASS | Secrets kept out of disk/logs; HTTPS + cert validation enforced.  |
| A03 Injection                              | ✅ PASS | Joi validation on all inputs; cron expression validated.          |
| A04 Insecure Design                        | ✅ PASS | Rate limiting, circuit breaker, and audit trail in place.         |
| A05 Security Misconfiguration              | ✅ PASS | Secure defaults; non-root execution; HTTPS forced in production.  |
| A06 Vulnerable & Outdated Components        | ✅ PASS | Dependencies current; `npm audit` reports 0 vulnerabilities.      |
| A07 Identification & Authentication Failures | 🟡 PARTIAL | Token auth with audit logging; no token expiry/refresh (see below). |
| A08 Software & Data Integrity Failures      | 🟡 PARTIAL | No SBOM or image signing; base image pinned by tag, not digest.   |
| A09 Security Logging & Monitoring Failures  | ✅ PASS | Structured, sanitized logs with correlation IDs and audit events. |
| A10 Server-Side Request Forgery (SSRF)      | ✅ PASS | URL scheme/host validation; HTTPS enforced in production.         |

**Score: 8 / 10 PASS** (2 partial, no failures).

---

## Dependency Security

`npm audit` reports **0 known vulnerabilities**. Production dependencies are
kept current (managed via Dependabot):

| Package                 | Version   |
| ----------------------- | --------- |
| `@actual-app/api`       | ^26.7.0   |
| `axios`                 | 1.19.0    |
| `axios-retry`           | ^4.5.0    |
| `dotenv`                | 17.4.2    |
| `joi`                   | 18.2.3    |
| `opossum`               | ^10.0.0   |
| `rate-limiter-flexible` | ^11.2.0   |
| `uuid`                  | ^14.0.1   |
| `winston`               | 3.19.0    |

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

The [Dockerfile](Dockerfile) uses the `node:lts-alpine` tag rather than a
pinned digest. For maximum supply-chain immutability, pin the base image to a
specific `sha256` digest.

### What logs do and do not contain

Logs **may** contain account names (treated as non-sensitive identifiers), sync
status, errors, and API endpoint URLs. Logs **do not** contain passwords,
access tokens, account balances, or stack traces.

---

## Remaining Improvements (Low Priority)

1. **Token lifecycle management** — expiration checks and refresh handling.
2. **Supply-chain hardening** — generate an SBOM, sign the container image, and
   pin the base image to a digest.
3. **Enhanced monitoring** — metrics/alerting on repeated auth failures and
   suspicious activity; optional syslog/HTTP log transport.
4. **Expanded security testing** — integration/fuzz tests and SAST (e.g. Snyk,
   SonarQube) in addition to the current ESLint + `npm audit` + Trivy pipeline.

None of these are blocking; they can be delivered post-launch without material
security risk.

---

## Deployment Security Checklist

Before deploying to production, ensure:

- [ ] Secrets are stored in a secret manager, not committed `.env` files.
- [ ] HTTPS is enforced for both API endpoints (required in production).
- [ ] The container runs as the non-root `nodejs` user.
- [ ] A specific base-image tag/digest is used (not `latest`).
- [ ] Logs are aggregated and monitored.
- [ ] Resource limits (CPU, memory) are configured.
- [ ] Access tokens have been rotated and scoped to least privilege.
- [ ] Network policies restrict container egress to the two API hosts.
- [ ] `npm audit` and the CI security workflow pass.
- [ ] The health check is configured and backups are tested.

---

## References

- [OWASP Top 10](https://owasp.org/Top10/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)
- [OpenSSF Best Practices](https://www.bestpractices.dev/)
