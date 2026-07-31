# GhostBudget - Implementation Summary

**Last Updated:** 2026-07-31
**Version:** 1.0
**Status:** ✅ Production ready

---

## Overview

GhostBudget is a one-shot CLI job that reads account balances from an
[Actual Budget](https://actualbudget.org/) server and writes them to matching
[Ghostfolio](https://ghostfol.io/) accounts. This document summarizes the
security, performance, and observability features currently implemented in the
codebase.

The entry point is [src/index.js](src/index.js), which runs a single `sync()`
and exits; there is no long-running server or HTTP endpoint.

---

## 🎯 Implementation Highlights

### Security

**1. Rate Limiting**
- **Package:** `rate-limiter-flexible` (`RateLimiterMemory`)
- **Implementation:** [src/ghostfolio.js:33-37](src/ghostfolio.js#L33-L37), consumed in [src/ghostfolio.js:102-105](src/ghostfolio.js#L102-L105)
- **Configuration:** 10 requests per second (`RATE_LIMIT_POINTS` / `RATE_LIMIT_DURATION` in [constants.js](src/config/constants.js))
- **Impact:** Throttles outbound calls to the Ghostfolio API

**2. Circuit Breaker**
- **Package:** `opossum`
- **Implementation:** [src/ghostfolio.js:75-95](src/ghostfolio.js#L75-L95)
- **Configuration:** 50% error threshold, 30s timeout, 30s reset
- **Impact:** Prevents cascading failures and logs a high-severity audit event when the breaker opens

**3. Retry with Exponential Backoff**
- **Package:** `axios-retry`
- **Implementation:** [src/ghostfolio.js:58-73](src/ghostfolio.js#L58-L73)
- **Configuration:** Up to `MAX_RETRIES` (default 3), retries on network/idempotent errors and HTTP 429
- **Impact:** Handles transient failures gracefully

**4. Enhanced TLS**
- **Implementation:** [src/ghostfolio.js:39-56](src/ghostfolio.js#L39-L56)
- **Features:**
  - TLS 1.2 minimum, TLS 1.3 maximum
  - Pinned cipher suite (`TLS_CIPHERS` in [constants.js](src/config/constants.js))
  - Certificate validation (`rejectUnauthorized: true`)
  - `honorCipherOrder` enabled
- **Impact:** Strong, predictable transport encryption

**5. Input & Config Validation**
- **Package:** `joi`
- **Implementation:** [src/utils/validation.js](src/utils/validation.js)
- **Features:**
  - Schema validation for `config.json` account mappings (`validateConfig`)
  - Schema validation for environment variables, including URL scheme/host checks and an HTTPS requirement in production (`validateEnvironment`)
  - Balance, account-name, and API-response validation (`validateBalance`, `validateAccountName`, `validateApiResponse`)
  - Defense-in-depth rejection of obviously malicious account names (`<script`, `javascript:`, `on*=`). Names are treated as identifiers and serialized as JSON only — they are intentionally **not** HTML-escaped, so legitimate names containing `& < > " '` still match across APIs
  - Error sanitization that strips stack traces before logging (`sanitizeError`)
- **Impact:** Rejects malformed input and prevents leaking sensitive data in logs

### Performance

**1. Connection Pooling**
- **Implementation:** [src/ghostfolio.js:44-54](src/ghostfolio.js#L44-L54)
- **Configuration:** Keep-alive (30s), max 50 sockets, max 10 free sockets
- **Impact:** Reuses TLS connections across API calls

**2. Response Caching**
- **Implementation:** [src/ghostfolio.js:28-31](src/ghostfolio.js#L28-L31) and [src/ghostfolio.js:156-183](src/ghostfolio.js#L156-L183)
- **Configuration:** `CACHE_TTL_MINUTES` (default 5); cache is invalidated after every balance update
- **Impact:** Avoids re-fetching the Ghostfolio account list within a run

**3. Batch Processing**
- **Implementation:** [src/actualBudget.js:44-69](src/actualBudget.js#L44-L69)
- **Configuration:** `BATCH_SIZE` accounts per batch (default 10)
- **Impact:** Bounds concurrency and memory use for large account lists

**4. Centralized Constants**
- **File:** [src/config/constants.js](src/config/constants.js)
- **Impact:** Single source of truth for timeouts, limits, TLS, and rate-limit settings

**5. Consolidated Environment Loading**
- **Implementation:** [src/index.js:2](src/index.js#L2)
- **Impact:** `dotenv` is loaded once at the entry point

### Observability

**1. Structured Logging with Correlation IDs**
- **Packages:** `winston`, `uuid`
- **Implementation:** [src/logger.js](src/logger.js)
- **Features:**
  - JSON logs with timestamps and service/version metadata
  - A per-process correlation ID added to every log line
  - File transports (`logs/combined.log`, `logs/error.log`) with rotation; silent transport under `NODE_ENV=test`
- **Impact:** Traceable, machine-parseable logs

**2. Audit Trail**
- **Implementation:** [src/utils/audit.js](src/utils/audit.js)
- **Events tracked:** authentication attempts, balance updates, sync start/complete/fail, security events (e.g. circuit-breaker open, XSS attempt), and validation failures — each stamped with a unique `event_id`
- **Impact:** Security-relevant events are recorded for forensics

**3. Enhanced Error Handling**
- **Implementation:** [src/index.js](src/index.js)
- **Features:** duration tracking, error-type categorization, graceful shutdown on `SIGTERM`/`SIGINT`, and handlers for unhandled rejections and uncaught exceptions
- **Impact:** Predictable failure behavior and better incident diagnosis

---

## 📦 Dependencies

### Production
```json
{
  "@actual-app/api": "^26.7.0",
  "axios": "1.19.0",
  "axios-retry": "^4.5.0",
  "dotenv": "17.4.2",
  "joi": "18.2.3",
  "opossum": "^10.0.0",
  "rate-limiter-flexible": "^11.2.0",
  "uuid": "^14.0.1",
  "winston": "3.19.0"
}
```

### Development
```json
{
  "@eslint/js": "10.0.1",
  "@typescript-eslint/eslint-plugin": "8.65.0",
  "eslint": "10.8.0",
  "eslint-config-prettier": "10.1.8",
  "eslint-plugin-prettier": "5.5.6",
  "eslint-plugin-security": "4.0.1",
  "jest": "30.4.2",
  "jsdoc": "^4.0.5",
  "nock": "14.0.16",
  "prettier": "3.9.6"
}
```

---

## 📁 Project Structure

```
src/
├── index.js              # Entry point: orchestrates sync, shutdown, error handling
├── actualBudget.js       # Fetches account balances from Actual Budget (batched)
├── ghostfolio.js         # Ghostfolio API client: auth, caching, rate limit, breaker, TLS
├── logger.js             # Winston logger with correlation IDs
├── config/
│   └── constants.js      # Centralized configuration constants
└── utils/
    ├── audit.js          # Security audit logging
    └── validation.js     # Joi-based config/env/input validation

tests/
├── actualBudget.test.js  # Actual Budget client tests (mocked @actual-app/api)
└── ghostfolio.test.js    # Ghostfolio client tests (HTTP mocked with nock)
```

---

## 🔒 Security Features

1. ✅ Rate limiting (10 req/s)
2. ✅ Circuit breaker pattern
3. ✅ Retry logic with exponential backoff
4. ✅ Enhanced TLS with cipher pinning and certificate validation
5. ✅ Schema-based config and environment validation (Joi)
6. ✅ HTTPS enforcement for external URLs in production
7. ✅ Audit trail for authentication, balance updates, and security events
8. ✅ Error sanitization (no stack traces or sensitive data in logs)

---

## ⚡ Performance Techniques

1. ✅ HTTP keep-alive / connection pooling
2. ✅ In-memory response caching with TTL and post-update invalidation
3. ✅ Batch processing for large account lists
4. ✅ Bounded retries and request timeouts

---

## 📊 Observability Capabilities

### Audit Events
1. **Authentication** — success/failure per service (Actual Budget, Ghostfolio)
2. **Balance updates** — per account
3. **Sync operations** — started / completed / failed with duration
4. **Security events** — circuit-breaker open, XSS attempt, etc.
5. **Validation failures** — environment and input validation

### Log Enhancements
1. **Correlation ID** — one per process, added to every log line
2. **Structured JSON** — timestamped, machine-parseable
3. **Service metadata** — service name and version
4. **File rotation** — size-capped `combined.log` and `error.log`

---

## 🧪 Testing Status

- **Linting:** ✅ PASS — `eslint` (with `eslint-plugin-security`), 0 errors
- **Unit tests:** ✅ PASS — 2 suites, 12 tests (`jest` + `nock`)
- **Test isolation:** `uuid` mocked and logging silenced under `NODE_ENV=test` ([jest.setup.js](jest.setup.js))

Run locally:
```bash
npm run lint
npm test
npm run test:coverage   # optional coverage report
```

---

## 📝 Configuration

All configuration is via environment variables (see [.env.example](.env.example)).

### Required
```bash
ACTUAL_BUDGET_URL=http://localhost:5006
ACTUAL_BUDGET_PASS=your-actual-server-password
ACTUAL_BUDGET_SYNC_ID=your-budget-sync-id
ACTUAL_BUDGET_DATA_DIR=/path/to/actual/data/directory

GHOSTFOLIO_URL=http://localhost:3333
GHOSTFOLIO_TOKEN=your-access-token
```

### Application (optional, with defaults)
```bash
NODE_ENV=production      # development | production | test
LOG_LEVEL=info           # error | warn | info | debug

CACHE_TTL_MINUTES=5      # 1–60
BATCH_SIZE=10            # 1–50
MAX_RETRIES=3            # 0–10
```

Account mappings live in `config.json` (see [config.json.example](config.json.example)),
validated against the schema in [src/utils/validation.js](src/utils/validation.js).

> **Note:** In production, both `ACTUAL_BUDGET_URL` and `GHOSTFOLIO_URL` must use HTTPS.

---

## 🚀 Deployment

### Steps
1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure environment:** copy variables from [.env.example](.env.example) and set values.
3. **Verify:**
   ```bash
   npm run lint
   npm test
   ```
4. **Run the sync:**
   ```bash
   npm run sync          # or: node src/index.js
   ```
   A container image ([Dockerfile](Dockerfile)) and [docker-compose.yml](docker-compose.yml)
   are also provided for scheduled runs.

### Notes
- No database migrations required.
- The job is idempotent — it can safely be re-run on a schedule (e.g. cron).

---

## 🔄 Future Enhancements

1. **Increase test coverage** — add cases for the circuit breaker, retry, and rate-limiter paths.
2. **Integration tests** — end-to-end sync flow against test servers.
3. **Configurable log destinations** — e.g. optional syslog/HTTP transport.

---

## 🎓 Key Design Decisions

1. **Rate limiting:** in-memory (`RateLimiterMemory`) for simplicity — can be swapped for a Redis-backed limiter if distributed runs are needed.
2. **Circuit breaker:** `opossum` for Node.js compatibility.
3. **Caching:** in-memory with TTL, scoped to a single run.
4. **Batch processing:** fixed batch size for predictable memory use.
5. **Validation:** `joi` schemas centralize input rules; account names are validated as identifiers, not HTML.
6. **Security by default:** HTTPS enforced in production; relaxed only for local development.

---

## 📚 Related Documents

- [README.md](README.md) — usage and setup
- [SECURITY.md](SECURITY.md) — security policy and audit report
