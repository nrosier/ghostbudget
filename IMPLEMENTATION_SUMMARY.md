# GhostBudget - Implementation Summary

**Last Updated:** 2026-08-14
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

This section is deliberately free of line-number links. It used to carry them, and
every one had gone stale — several pointed at code that no longer existed. Module
links only, and the code's own comments carry the reasoning.

### Security

**1. Retry with Exponential Backoff**
- **Package:** `axios-retry`
- **Implementation:** [src/ghostfolio.js](src/ghostfolio.js)
- **Configuration:** Up to `MAX_RETRIES` (default 3), retries on network/idempotent errors and HTTP 429, each delay capped at `MAX_RETRY_DELAY_MS`
- **Impact:** Handles transient failures gracefully. This is the only resilience layer around the HTTP client — see "Controls that were removed" below

**2. TLS**
- **Implementation:** [src/config/tls.js](src/config/tls.js) (process-wide floor) and [src/ghostfolio.js](src/ghostfolio.js) (agent)
- **Features:**
  - TLS 1.2 minimum, TLS 1.3 maximum, set process-wide so `@actual-app/api`'s own connections are covered too
  - Certificate validation (`rejectUnauthorized: true`)
  - **No cipher allowlist.** There was one; it permitted only `ECDHE-RSA` suites for TLS 1.2, which fails the handshake against an ECDSA certificate, and its TLS 1.3 entries were inert because Node's `ciphers` option governs TLS 1.2 and below only
- **Impact:** A version floor that holds on both legs of the egress, without breaking real servers

**3. Input & Config Validation**
- **Package:** `joi`
- **Implementation:** [src/utils/validation.js](src/utils/validation.js)
- **Features:**
  - Schema validation for `config.json` account mappings (`validateConfig`), including a required ISO 4217 `currency` per mapping and a uniqueness constraint on `ghostfolioName`
  - Schema validation for environment variables (`validateEnvironment`), plus `assertTransportSecurity`: plaintext `http://` is refused for any host outside a local network, in every environment
  - Balance, factor, account-name and account-id validation (`validateBalance`, `validateFactor`, `validateAccountName`, `validateAccountId`); response-shape checks live at their point of use in [src/ghostfolio.js](src/ghostfolio.js)
  - Defense-in-depth rejection of obviously malicious account names (`<script`, `javascript:`, `on*=`). Names are treated as identifiers and serialized as JSON only — they are intentionally **not** HTML-escaped, so legitimate names containing `& < > " '` still match across APIs
  - Error sanitization that strips stack traces before logging (`sanitizeError`)
- **Impact:** Rejects malformed input and prevents leaking sensitive data in logs

### Performance

**1. Connection Reuse**
- **Implementation:** [src/ghostfolio.js](src/ghostfolio.js)
- **Configuration:** `keepAlive` only. The pool used to be sized at 50 sockets / 10 free, which described concurrency this process does not have: a sync awaits each account in turn, so one socket is ever in use
- **Impact:** One TLS handshake for a run instead of one per account

**2. Centralized Constants**
- **File:** [src/config/constants.js](src/config/constants.js)
- **Impact:** Single source of truth for timeouts, limits, TLS versions, and scheduler intervals

**3. Consolidated Environment Loading**
- **Implementation:** [src/index.js](src/index.js)
- **Impact:** `dotenv` is loaded once at the entry point

### Observability

**1. Structured Logging with Correlation IDs**
- **Package:** `winston` (correlation IDs from `crypto.randomUUID()`)
- **Implementation:** [src/logger.js](src/logger.js)
- **Features:**
  - JSON logs with timestamps and service/version metadata
  - A per-process correlation ID added to every log line
  - File transports (`logs/combined.log`, `logs/error.log`) with rotation; silent transport under `NODE_ENV=test`
- **Impact:** Traceable, machine-parseable logs

**2. Audit Trail**
- **Implementation:** [src/utils/audit.js](src/utils/audit.js)
- **Events tracked:** authentication attempts, balance updates, sync start/complete/fail/skipped, security events (e.g. a rejected account name), and validation failures
- **Impact:** Security-relevant events are recorded for forensics, timestamped and correlated by the logger rather than by each call site

**3. Enhanced Error Handling**
- **Implementation:** [src/index.js](src/index.js)
- **Features:** duration tracking, error-type categorization, graceful shutdown on `SIGTERM`/`SIGINT`, and handlers for unhandled rejections and uncaught exceptions
- **Impact:** Predictable failure behavior and better incident diagnosis

### Controls that were removed

Each of these was implemented, documented here as a feature, and then found unable
to do its job in this process. A one-shot sync that makes a handful of sequential
requests and exits is a narrower setting than the patterns assume.

| Removed | Why |
| --- | --- |
| **Circuit breaker** (`opossum`) | Opened at a 50% error rate over the shared request stream. On a run where auth and the account fetch succeed and then some account `PUT`s fail, the third failure opened it and every remaining account was rejected locally as "Breaker is open" — never sent, real error lost from the summary and the audit trail. Its 30 s `resetTimeout` could never elapse inside a one-shot process. The wall-clock bound is the scheduler's `SYNC_TIMEOUT_MS`. |
| **Rate limiting** (`rate-limiter-flexible`) | Allowed 10 req/s, but the sync `await`s each account in turn, so concurrency is one and a run makes about `2 + N` requests. Sequential execution is the tighter bound; the queue never queued anything. |
| **Batch processing** (`BATCH_SIZE`) | Described as bounding concurrency and memory for large account lists. `@actual-app/api` reads balances from a local better-sqlite3 database whose calls are synchronous, so `Promise.all` over a slice overlapped nothing and every balance landed in the same array regardless. |
| **Response caching** (`CACHE_TTL_MINUTES`) | The account list is fetched once per run, and the cache was invalidated after every balance update, so it never served a read. |
| **`validateApiResponse`** | `field in body` is satisfied by a present-but-null `authToken` and by an `accounts` that is a string. Both call sites already followed it with a stricter check of the same field, which is what remains. |
| **Per-event `event_id` / `timestamp`** | The timestamp duplicated the one winston's `format.timestamp()` adds to every record; the UUID sat beside a per-process `correlationId` with nothing reading it. Removing them removed the `uuid` dependency, since `crypto.randomUUID()` covers the correlation ID. |

---

## 📦 Dependencies

### Production
```json
{
  "@actual-app/api": "^26.8.1",
  "axios": "1.19.0",
  "axios-retry": "^4.5.0",
  "croner": "10.0.1",
  "dotenv": "17.4.2",
  "joi": "18.2.3",
  "winston": "3.19.0"
}
```

### Development
```json
{
  "@eslint/js": "10.0.1",
  "@typescript-eslint/eslint-plugin": "8.67.0",
  "eslint": "10.8.1",
  "eslint-config-prettier": "10.1.8",
  "eslint-plugin-prettier": "5.5.6",
  "eslint-plugin-security": "4.0.1",
  "jest": "30.4.2",
  "jsdoc": "^4.0.5",
  "nock": "14.0.17",
  "prettier": "3.9.6"
}
```

Three direct production dependencies were dropped in the leaning-out pass —
`opossum`, `rate-limiter-flexible` and `uuid` — for the reasons in the table above.
The first two left `package-lock.json` entirely. `uuid` did not: `@actual-app/api`
depends on it, so it stays in the tree transitively and a scanner still sees it.
See [SECURITY.md](SECURITY.md) for the precise version of that claim.

---

## 📁 Project Structure

```
src/
├── scheduler.js          # Long-running container entry: cron, forks one sync per run
├── index.js              # Sync entry point: orchestrates sync, shutdown, error handling
├── actualBudget.js       # Fetches account balances from Actual Budget
├── ghostfolio.js         # Ghostfolio API client: auth, account matching, balance PUTs
├── healthcheck.js        # Container HEALTHCHECK probe
├── logger.js             # Winston logger with correlation IDs
├── config/
│   ├── constants.js      # Centralized configuration constants
│   └── tls.js            # Process-wide TLS version floor
└── utils/
    ├── audit.js          # Security audit logging
    ├── exit.js           # Flush log transports before exiting
    └── validation.js     # Joi-based config/env/input validation

tests/                    # One suite per module above, plus scheduler supervision
```

---

## 🔒 Security Features

1. ✅ Retry logic with exponential backoff and a capped delay
2. ✅ TLS 1.2 floor set process-wide, with certificate validation
3. ✅ Schema-based config and environment validation (Joi)
4. ✅ Plaintext HTTP refused for any host outside a local network, in every environment
5. ✅ Audit trail for authentication, balance updates, and security events
6. ✅ Error sanitization (no stack traces, sensitive data, or balance values in logs)
7. ✅ Non-root container user, read-only root filesystem, dropped capabilities
8. ✅ Refusal to write inside protected data directories (`PROTECTED_DATA_DIRS`)

---

## 🛡️ Write Integrity

The only field this job writes is `balance`, on accounts named in `config.json`.
An incorrect balance is a worse outcome than a stale one, so the write path is
built to refuse rather than guess. Implementation: [src/ghostfolio.js](src/ghostfolio.js).

1. ✅ **Resolve everything, then write.** `syncAccountBalances` computes every intended write before sending the first one, so a check spanning the whole mapped set can exist
2. ✅ **`config.json` read before authenticating** — a local mistake does not exchange a credential first
3. ✅ **All-zero refusal.** One zero is a real balance and is written; every mapped account reading zero at once is what an unfinished budget sync looks like, and writes nothing at all
4. ✅ **Ambiguity refused, not resolved by picking.** A name matching more than one account on either side fails that mapping (`exactlyOneNamed`); `Array.prototype.find()` used to send the balance to whichever the API listed first
5. ✅ **Currency compared, never converted.** The required `currency` per mapping is checked against the Ghostfolio account; a mismatch fails that account and the run continues
6. ✅ **Every write read back.** After the writes, the account list is fetched again and each written balance compared with the one sent; a difference of `BALANCE_EPSILON` or more fails that account (`confirmStoredBalances`). This used to compare against the *update* response, which carries a Prisma `Account` — a model with no `balance` column at all — so the comparison never ran and every write logged "unconfirmed". A check that cannot fire is worse than no check
7. ✅ **Unchanged balances are not rewritten** — the cheapest way to not store a wrong number is to not write
8. ✅ **Per-mapping failure isolation** — the accounts that could be synced were, and the run exits non-zero with a count
9. ✅ **`DRY_RUN=true`** resolves and reports every mapping without sending a write

---

## ⚡ Performance Techniques

1. ✅ HTTP keep-alive, so one handshake serves a whole run
2. ✅ Bounded retries and per-request timeouts
3. ✅ A hard `SYNC_TIMEOUT_MS` wall-clock bound enforced by the scheduler

The list above is short on purpose. A run reads a local SQLite file and makes
roughly `2 + N` HTTPS requests for `N` mapped accounts; there is very little here
for a performance technique to act on, which is what made the removed controls
removable.

---

## 📊 Observability Capabilities

### Audit Events
1. **Authentication** — success/failure per service (Actual Budget, Ghostfolio)
2. **Balance updates** — per account, recording whether the value actually changed and whether a request was sent (`written`, plus `dry_run` under `DRY_RUN`)
3. **Sync operations** — started / completed / failed / skipped, with duration and, once the sync has run, what it did: `mapped`, `resolved`, `changed`, `written`, `confirmed`, `unchanged`, `failed` and `dry_run`. A partially failed run carries the same counts, so the balances it did store are on the record. The completed record used to report `accounts_synced: balances.length` — the number of accounts in Actual Budget, so a budget with 20 accounts and two mappings audited a successful sync of 20; that number is now `accounts_in_budget`
4. **Security events** — e.g. a rejected account name, a protected-path write
5. **Validation failures** — environment and input validation

### Log Enhancements
1. **Correlation ID** — one per process, added to every log line
2. **Structured JSON** — timestamped, machine-parseable
3. **Service metadata** — service name and version
4. **File rotation** — size-capped `combined.log` and `error.log`

---

## 🧪 Testing Status

- **Linting:** ✅ PASS — `eslint` (with `eslint-plugin-security`), 0 errors
- **Unit tests:** ✅ PASS — `jest` + `nock`, one suite per module
- **Test isolation:** logging silenced under `NODE_ENV=test`, and `nock.disableNetConnect()` so no test can open a socket ([jest.setup.js](jest.setup.js)). The suites point at `http://localhost:3333` — Ghostfolio's own default port — so a test missing an interceptor used to send a real balance `PUT` to whatever was listening on the developer's machine
- **Thresholds:** [jest.config.js](jest.config.js) sets per-path coverage floors. They exist to stop
  coverage sliding backwards, so raise them when it improves rather than leaving headroom to delete
  tests into

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

MAX_RETRIES=3            # 0–10
DRY_RUN=false            # resolve and report every mapping, write nothing
```

Operators who still have `CACHE_TTL_MINUTES` or `BATCH_SIZE` set do not need to
remove them: the environment schema allows unknown keys, so a stale variable is
ignored rather than fatal.

Account mappings live in `config.json` (see [config.json.example](config.json.example)),
validated against the schema in [src/utils/validation.js](src/utils/validation.js).

> **Note:** both `ACTUAL_BUDGET_URL` and `GHOSTFOLIO_URL` must use `https://` unless
> the host is one only a local network can reach (`localhost`, an RFC 1918 address, a
> `.local`/`.internal` name, or a single-label name such as a Compose service). This
> does not depend on `NODE_ENV`.

> **Note:** each `config.json` mapping requires a `currency` field (ISO 4217). A
> config written against an earlier version fails validation at startup, before
> anything is written.

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

1. **Integration tests** — end-to-end sync flow against test servers.
2. **Configurable log destinations** — e.g. optional syslog/HTTP transport.

Note what is *not* on this list: adding a resilience layer back. If one is ever
wanted, the thing to add is per-account isolation that keeps a failing mapping from
affecting the others — which is what the sync already does by collecting failures
and reporting them together.

---

## 🎓 Key Design Decisions

1. **One request at a time:** the sync `await`s each account in turn. Sequential execution is a tighter bound than any limiter would impose, and it makes each account's failure independently attributable.
2. **Retry, and nothing above it:** transient failures are worth retrying; a shared-state control that can refuse requests on another account's behalf is not appropriate for a run this short. The wall-clock backstop is the scheduler's `SYNC_TIMEOUT_MS`, escalating `SIGTERM` to `SIGKILL`.
3. **Fail per account, report once:** a bad mapping fails its own account and the run raises a single error naming every failure, so one stale entry cannot hide the others.
4. **Validation:** `joi` schemas centralize input rules; account names are validated as identifiers, not HTML. Response shapes are checked at their point of use, where the expected type is known.
5. **The host decides the transport rule, not `NODE_ENV`:** plaintext is refused wherever the traffic could leave a local network, and accepted where it cannot. The previous rule was conditional on `NODE_ENV=production`, which made the documented Compose deployment unstartable (the image sets `NODE_ENV=production`) while letting a run with `NODE_ENV` unset send credentials in the clear to a remote host. What determines the exposure is the host.
6. **Refusing beats guessing, on every write path:** ambiguous account names, a currency that disagrees, an all-zero read, a stored value that does not match what was sent — each of these ends in nothing being written rather than something plausible. The tool's output is a number the operator will treat as their bank balance, so an absent update is recoverable in a way a wrong one is not.
7. **Balance values appear nowhere but the request body:** not in logs, not in audit records, and not in error messages — which is why the guards name the limit or the account instead of the value. `error.log` sits on a mounted volume and outlives the process.
8. **Prefer the standard library:** `crypto.randomUUID()` over a UUID package — same CSPRNG, one fewer dependency to install, audit and mock around.

---

## 📚 Related Documents

- [README.md](README.md) — usage and setup
- [SECURITY.md](SECURITY.md) — security policy and audit report
