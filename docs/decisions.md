# Design decisions

Why the code looks the way it does, where "the way it does" was arrived at by removing
or replacing something that did not work.

The rule each entry produced lives in the code, next to the thing it governs. This file
holds the reasoning — the shape that was there before, why it failed, and what it cost —
so that a future change knows what it is undoing. Source comments point here by heading.

Read it as history, not as documentation of current behaviour. For what the code does
today, see [README.md](../README.md); for the security posture, [SECURITY.md](../SECURITY.md).

---

## Startup and configuration

### The environment is validated once, on demand

`src/config/env.js`, `getClient()` in `src/ghostfolio.js`

Validation used to happen in the Ghostfolio client's constructor, and the module ended
with `module.exports = new GhostfolioAPI()` — so the constructor ran at require time.
`require('./ghostfolio')` on the second line of `src/index.js` therefore threw before that
file had installed a single process handler.

A single bad variable produced a raw stack trace on stderr and _nothing at all_ in
`combined.log` or `error.log`: winston's file transports are asynchronous and the process
was gone before the write landed. The two files an operator reads to answer "why did
tonight's sync not run" were the two with no answer.

Both service modules also ran the whole schema against `process.env` independently, so a
run validated twice, logged the same debug lines twice, and could in principle have
disagreed with itself.

The client is now constructed on first use, inside `sync()`'s `try`, and the environment
is memoized: one validation per process, inside the guarded path, where a failure is
logged, audited and flushed like every other one.

### The URL schema checks shape, not hostname

`envSchema` in `src/utils/validation.js`

The pattern that used to validate `ACTUAL_BUDGET_URL` and `GHOSTFOLIO_URL` permitted only
`localhost`, `127.0.0.1` and dotted names with a TLD. So `http://actual_server:5006` — a
Docker Compose service name, which is what the recommended deployment actually uses — was
rejected outright. Which schemes are acceptable for which hosts is a question that needs
the parsed host, and is answered by `assertTransportSecurity`.

### Plaintext HTTP is decided by the host, not by `NODE_ENV`

`assertTransportSecurity()` in `src/utils/validation.js`

The rule used to require HTTPS only when `NODE_ENV=production`, which was wrong in both
directions.

Too strict for the deployment this project recommends: the image sets
`NODE_ENV=production`, so a compose file talking to `http://actual_server:5006` over the
container network could not start at all — and `.env.example`, which ships
`NODE_ENV=production` alongside `http://localhost` URLs, could not start either.

Too lax where it mattered: a developer who had not set `NODE_ENV` sent the Actual Budget
password and the Ghostfolio token in the clear to whatever remote host was configured.

Keying on the host protects the case that is actually dangerous — credentials crossing a
network someone else can see — in every environment, and permits the case that is not.

### `validateFactor` is not `validateBalance`

`src/utils/validation.js`

A balance may legitimately be negative or zero; a factor may not. Reusing the balance
validator for factors meant `factor: 0` (every balance silently becomes 0) and `factor: -1`
(every sign flipped) passed validation on the public `updateAccountBalance` path. The Joi
config schema already enforces `positive()`, so the gap only affected direct callers — which
is exactly the boundary a public method has to defend.

### `CACHE_TTL_MINUTES` and `BATCH_SIZE` are gone

`envSchema` in `src/utils/validation.js`, `getGhostfolioAccounts()`, `getAccountBalances()`

Each configured something that could not take effect in a one-shot process.

The cache held the Ghostfolio account list with a configurable TTL and was invalidated
after every balance update — in a process that fetches that list exactly once and exits.
It never served a single read, whatever the TTL was set to.

The batching read Actual Budget balances in `BATCH_SIZE`-sized slices, described as
preventing memory issues with large account lists. `@actual-app/api` reads balances out of
a local better-sqlite3 database and its calls are synchronous, so `Promise.all` never
overlapped any work and the slices never bounded anything — every balance ended up in the
same array either way. What was left was a loop, an environment variable and a log line
per batch.

Unknown environment variables are still allowed, so an operator who has either set in a
`.env` file sees no error. It simply does nothing, as before.

### `MAX_RETRIES` has one home

`envSchema` in `src/utils/validation.js`, `src/config/constants.js`

The schema defaulted to a literal `3`, `constants.MAX_RETRIES` was also `3`, and the client
then wrote `env.MAX_RETRIES ?? constants.MAX_RETRIES` over the top: three places for one
number, two of which could go stale unnoticed, and a `??` whose right-hand side was
unreachable but read as though the two could differ. The schema now defaults from the
constant and the client reads the schema's value.

### The password and token floors are real floors

`MIN_PASSWORD_LENGTH`, `MIN_TOKEN_LENGTH` in `src/config/constants.js`

Both were 1, which rejected only the empty string — `ACTUAL_BUDGET_PASS=x` validated
happily. They are named like strength controls, so they now behave like them. A Ghostfolio
access token is a generated UUID (36 characters), so a 16-character floor rejects typos and
truncated copy-pastes without rejecting any real token.

### The log directory is anchored to the application root

`logDir()` in `src/config/constants.js`

`logs/combined.log` resolves against the _working directory_, so it only worked because the
old crontab entry did `cd /app` first. Any other caller — a systemd unit with a different
`WorkingDirectory`, a developer running the sync from a subdirectory — silently scattered
log files or lost them entirely.

### `PROTECTED_DATA_DIRS` outlived the chown that motivated it

`src/utils/validation.js`

The container entrypoint used to run `chown -R` against `ACTUAL_BUDGET_DATA_DIR` as root,
so `ACTUAL_BUDGET_DATA_DIR=/` rewrote ownership across the whole filesystem. That chown is
gone with the container's root phase, but the value still decides where a SQLite database
is created and where the process demands write access, so pointing it at a system directory
is never what an operator meant.

---

## Writing balances

### The account PUT projects onto the DTO's field set

`UPDATABLE_ACCOUNT_FIELDS` in `src/ghostfolio.js`

The payload used to be hand-built from seven fixed fields, which meant any field the
account model gained was sent absent — and on a PUT that is a reset, not a no-op.

The obvious fix is to spread the fetched account, but that breaks against the live API:
Ghostfolio's NestJS validation pipe runs with `forbidNonWhitelisted: true`, so a single
property outside the DTO fails the whole request with a 400, and the GET response carries
plenty of them — computed values, the expanded platform, tag objects.

So the fetched account is projected onto the DTO's own field set: nothing is invented,
nothing outside the contract is sent, and a field added to the DTO is one entry away from
being carried through.

`tags` is excluded deliberately. It is in the DTO, but the GET returns tag _objects_ while
the DTO expects an array of ids, and Ghostfolio implements the update as
delete-all-then-create — so sending them back would either fail validation or destroy the
account's tags. Omitting the property leaves the existing associations untouched.

Verified against `ghostfolio/ghostfolio@main`:
`libs/common/src/lib/dtos/update-account.dto.ts`, `apps/api/src/main.ts`,
`apps/api/src/app/account/account.service.ts`.

### An unchanged balance is not rewritten

`updateAccountBalance()` in `src/ghostfolio.js`

The PUT used to fire regardless of whether the balance had moved; the `changed` flag only
decided what the audit trail said about it. So a nightly run rewrote every mapped account's
balance every night, including the ones that had not moved. Every write is an opportunity
to store the wrong number, and the cheapest way to not store a wrong number is to not
write. On a typical run this now skips all of them.

### `updateAccountBalance` returns an outcome, not a response body

`src/ghostfolio.js`

It used to return the update response, which no caller read and which carries nothing worth
reading — see the next entry. The three outcomes (`'written'`, `'unchanged'`, `'dry_run'`)
are what the caller has to report and cannot work out for itself.

### Confirmation reads the account list back, not the update response

`confirmStoredBalances()` in `src/ghostfolio.js`

A 2xx is not the claim this tool needs to make. The claim is "the balance in Ghostfolio is
the balance from Actual Budget", and the only way to establish it is to ask Ghostfolio what
it now holds.

The check used to compare against the balance in the update response, which cannot work:
`PUT /api/v1/account/:id` returns a Prisma `Account`, and that model has no `balance`
column at all — balances live in `AccountBalance` rows keyed by (accountId, date), which
`updateAccount` writes separately under today's date. So the response never carried a
balance, the comparison never ran, and every write logged "could not confirm" instead. A
check that cannot fire is worse than no check, because the log says something was verified.

The account list does carry `balance`: Ghostfolio derives it as the most recent non-future
`AccountBalance` value, which after a write today is the value written. One extra GET per
run confirms every write in it.

### Config is read before authenticating

`syncAccountBalances()` in `src/ghostfolio.js`

`config.json` used to be read after authenticating, so a mistyped mapping file still
exchanged the security token for an auth token and fetched the account list before failing
on something entirely local to this machine.

### Resolve everything, then write

`syncAccountBalances()` in `src/ghostfolio.js`

Resolution used to be interleaved with writing, one mapping at a time, so the first
accounts were already written before the later ones had been looked at. A check that
depends on the whole set could not exist. Splitting the loop in two is what makes the
all-zero gate below possible; both phases still record per-mapping failures and carry on,
so one bad mapping does not cost the others their sync.

### The all-zero gate

`syncAccountBalances()` in `src/ghostfolio.js`

A zero is a valid balance — an emptied account really does hold nothing — so no single
value can be rejected on its own. Every mapped account reading zero at once is a different
claim, and not one a real set of accounts makes. It is what a budget that downloaded but
did not apply its sync messages looks like, or a wrong `ACTUAL_BUDGET_SYNC_ID` pointing at
an empty budget. None of those throw, so every guard upstream passes and the run would
overwrite real balances with zeros and report success.

Refusing before phase two means not one account is touched.

### Currency is declared in the config and compared

`resolveMapping()` in `src/ghostfolio.js`

Neither API states the currency of an Actual Budget balance. Without a declared currency to
compare, a balance denominated in one currency was written verbatim into an account
denominated in another — no error, no warning, just the wrong amount of money from then on.

`factor` is not a substitute: using it as an exchange rate freezes that rate into the
config, where it silently goes stale.

### A mapping that matches two accounts is refused, not resolved

`exactlyOneNamed()` in `src/ghostfolio.js`

This was `Array.prototype.find()` on both sides of a mapping, which takes the first match and
says nothing about the rest. Neither system enforces unique account names, so two accounts
named "Savings" meant the balance went to whichever one the API happened to list first — the
other was never touched, the run reported success, and nothing anywhere said the name had
been ambiguous. For a mapping that addresses accounts _by name_, more than one match is not
something to resolve by picking; it is a configuration that cannot be carried out.

### Rounding happens in minor units

`toStoredBalance()` in `src/ghostfolio.js`

Actual Budget stores balances as integer cents, but a factor need not be an integer, and
float arithmetic on the way out produced values like `1100.1320000000001` from
`100012 * 1.1 / 100` — sent verbatim to a financial API and stored as the account's
balance. The function is shared rather than inlined because the write and the read-back that
confirms it need the same number; two copies of the expression could drift by a cent and
turn every confirmed write into a reported mismatch.

### The read leg had no retry at all

`getAccountBalances()` in `src/actualBudget.js`

`axios-retry` is configured on the Ghostfolio client, and `@actual-app/api` builds its own
HTTP client, so it never covered the Actual Budget leg. `api.init()` and
`api.downloadBudget()` are both network calls and both failed the whole run on their first
transient error — including the case that motivated this, a server still starting up when
the scheduled sync fires at 05:00, where nothing was wrong except the timing.

Connect and download retry as one unit rather than separately, and every attempt after the
first starts from a full `shutdown()`. `@actual-app/api` holds a server session and a local
SQLite handle; calling `init()` again on top of one that failed part-way is how a retry
turns a transient failure into corrupt local state. The download is inside the loop for the
same reason it needs the retry: it reads the budget over the network, so it fails for the
same reasons the connect does, and re-downloading wants a fresh session.

Retries are an allowlist, not a denylist. A wrong password, an unwritable data directory
and a malformed sync ID are permanent — attempting any of them four times against the
server gains nothing and muddies the audit trail — so an unrecognised failure still fails
on the first attempt, as it did before. `Could not get remote files` is in the allowlist
even though a wrong sync ID also produces it: retrying that costs four attempts inside
seven seconds and reports the identical failure, which is the cheaper mistake.

`AuditLogger.logAuth(true, …)` stays inside the loop, so a run that connected twice records
two authentications. That is what happened.

### `Promise.all` made one unreadable account fatal for all of them

`getAccountBalances()` in `src/actualBudget.js`

The balances were read with `Promise.all` over the account list, with the validators called
inside the map. So a single account that failed either validator rejected the whole thing —
a closed or off-budget account returning `null`, a name that is empty or oversized, a
magnitude that is a corrupted read — and no account in the budget was synced. The write side
had implemented the opposite rule for a long time: "one bad mapping does not cost the others
their sync."

Skipping the account is safe because a skipped account is _absent_, not wrong. `exactlyOneNamed`
then fails that mapping with `No matching Actual Budget account found for X`, which
`syncAccountBalances` records per-mapping, so the run still exits non-zero carrying that
account's own reason while every other account syncs. Nothing is written for the skipped one
either way; what changes is whether the accounts behind it get written. If no account can be
read the list comes back empty, and `src/index.js` already refuses that as `No balances
received from Actual Budget` rather than reporting a sync over nothing. The all-zero gate is
unaffected: a skipped account never becomes a target, so it cannot make the remaining set
look uniformly zero.

The loop is sequential, which costs nothing: `@actual-app/api` reads balances out of a local
better-sqlite3 database and its calls are synchronous, which is the same reason the
`BATCH_SIZE` above bounded nothing.

The name of an account that failed name validation is not logged. It is exactly the value
that just failed validation, and `error.log` sits on a mounted volume.

### Retry is the only resilience layer

`GhostfolioAPI` constructor in `src/ghostfolio.js`

There was a rate limiter and a circuit breaker wrapped around the axios instance. Neither
could do its job in this process, and the breaker did active harm.

The limiter allowed 10 requests per second, but a sync issues its requests strictly
sequentially — one `await` per account — so at most one is ever in flight. One-at-a-time is
a tighter bound than 10/s, and the queue in front of it never queued anything.

The breaker opened at a 50% error rate over the shared request stream. In a run where
authentication and the account fetch succeed and then some account PUTs fail — a couple of
stale mappings, say — the third failure opened it, and from that point every remaining
account was rejected locally with "Breaker is open". So three bad mappings stopped the
accounts behind them from being written at all, and replaced each one's real Ghostfolio
error in the summary and the audit trail with the breaker's own message. Its 30 s
`resetTimeout` could not help either: a sync is a one-shot process that exits long before
it elapses.

The wall-clock backstop is the scheduler's `SYNC_TIMEOUT_MS`, which bounds the whole run and
escalates to SIGKILL.

### The connection pool is not sized

`GhostfolioAPI` constructor in `src/ghostfolio.js`

A sync issues its requests one at a time, so the pool never holds more than one socket and
sizing it is meaningless. `keepAlive` is the part that earns its place: it reuses that
socket instead of re-handshaking TLS for every account.

---

## Logging and the audit trail

### Balances are never logged, in any environment

`getAccountBalances()` in `src/actualBudget.js`

The balance log line used to be gated on `NODE_ENV !== 'production'`, which meant every
balance was written to `logs/combined.log` on a developer machine and in any deployment that
had not set `NODE_ENV` — while `SECURITY.md` stated flatly that logs do not contain
balances. The gate went rather than the claim: a log file is the wrong place for account
values regardless of environment, and it outlives the process on a mounted volume. The
operator can read both values in Ghostfolio's own UI.

Account _names_ are logged. Balance values are not, anywhere.

### `error_type` is decided by `error.code`

`classifyError()` in `src/index.js`

The audit trail's `error_type` used to be decided by `message.includes('network')`, which
nothing that reaches there ever says: Node reports `connect ECONNREFUSED 127.0.0.1:3333`,
axios reports `timeout of 30000ms exceeded`. So every run that failed because a service was
unreachable — the most common way for this job to fail — was recorded as `unknown_error`,
and the only thing that ever reached the network arm was a test supplying a message it had
written for the purpose.

The codes survive the trip because `authenticate()` and `getAccountBalances()` rethrow what
they caught rather than wrapping it.

### `accounts_in_budget`, not `accounts_synced`

`sync()` in `src/index.js`, `syncAccountBalances()` in `src/ghostfolio.js`

The top-level audit record used to report `accounts_synced: balances.length` — the number of
accounts in Actual Budget. A budget with 20 accounts and two mappings audited a successful
sync of 20. That number is still worth recording, under a name that is true of it, and the
counts that describe the sync come from the sync, which is the only thing that knows them.

### Audit payloads carry no `timestamp` or `event_id`

`src/utils/audit.js`

Every payload used to add `timestamp: new Date().toISOString()` and an `event_id` UUID. The
timestamp duplicated the one winston's `format.timestamp()` already puts on every record.
The id was a second identifier alongside the per-process `correlationId` from `logger.js`,
with nothing consuming it: there is no separate audit sink, and no query that needs to
address one event rather than one run. Both are gone, and the `uuid` dependency with them.

### `version` in the log metadata is the build's, not a literal

`src/logger.js`, `src/config/version.js`

It was the string `'1.0.0'` — a second copy of `package.json`'s version that could not tell
two builds of the same version apart. It now comes from `package.json` itself, alongside the
commit the build was made from.

### Joi details are deduplicated

`summarizeDetails()` in `src/utils/validation.js`

`abortEarly: false` reports every failure, and a schema failure is usually the same failure
repeated: a `config.json` written against an earlier version has no `currency` on any
mapping, so six accounts produced six verbatim copies of the same 230-character
explanation, joined into one log line and one error message. Reading it meant scrolling past
five copies to check they were copies. The count and the paths are what differ, so those are
what is kept.

### `validateApiResponse` is gone

`src/utils/validation.js`

There was a generic `validateApiResponse(response, requiredFields)`. Both of its call sites
in `ghostfolio.js` followed it immediately with a stricter check of the same field — `in` is
satisfied by a present-but-null `authToken`, and by an `accounts` that is a string — so the
specific check was doing the work and the generic one only decided which of two error
messages came out. The checks that remain are at their point of use.

---

## The scheduler and the container

### A Node scheduler replaced BusyBox `crond`

`src/scheduler.js`

With it went an entire class of fragility:

- **No root phase.** `crond` had to start as root to install a crontab for another user, so
  PID 1 ran as root for the container's whole lifetime and only the sync itself dropped to
  `nodejs`. This process runs as `nodejs` from the first instruction.
- **Secrets no longer depend on a BusyBox quirk.** The old design wrote non-sensitive
  variables to `/app/project_env.sh` and relied on BusyBox `crond` leaking its own
  environment to jobs for `ACTUAL_BUDGET_PASS` and `GHOSTFOLIO_TOKEN` to arrive at all.
  Vixie cron and cronie build a clean environment and would have dropped both, so any change
  of base image would have broken authentication. A child process inherits the environment
  directly, by definition.
- **`CRON_TASK` is no longer interpolated into a shell command line**, so a real parser can
  validate it instead of a character allowlist.
- **Overlapping runs are refused.** Two runs would have two processes opening the same
  Actual Budget SQLite database. BusyBox cron happily did exactly that.
- **Output goes to `docker logs` directly.** The old design appended it to
  `/var/log/cron.log` and kept a `tail -f` alive to relay it.

Each run is still a separate OS process, deliberately: `@actual-app/api` opens a native
better-sqlite3 handle and a sync that dies before `api.shutdown()` leaves it behind, so
process-per-run keeps a bad run from poisoning the next one — the same isolation cron gave
us for free.

### The health check proves a heartbeat, not a process

`src/healthcheck.js`

It was `node -e "process.exit(0)"`, which reported healthy no matter what was happening —
including the case the old design made likely, where `crond` had died but the `tail -f`
relay kept PID 1 alive, so the container looked fine and never synced again.

A failed _sync_ deliberately does not make the container unhealthy. Syncs fail for reasons
outside this container — Actual Budget down, Ghostfolio unreachable, credentials rotated —
and restarting on those would turn a remote outage into a crash loop that fixes nothing.

### The `ACTUAL_BUDGET_DATA_DIR` check is not optional

`validateDataDir()` in `src/utils/validation.js`

The old entrypoint silently skipped its `[ -d ]` guard when the path did not exist, and
Actual Budget then wrote to a location that was not persisted. The check now runs at
scheduler startup and reports the resolved path.

### `CRON_TASK` is parsed, not character-checked

`normalizeSchedule()` in `src/scheduler.js`

The old shell validation only checked which characters appeared, so it accepted
`* * * * * * *` and rejected `@daily`. The field count is now checked, nicknames are
supported, and croner parses the pattern, so out-of-range values and patterns that can never
match are caught at startup instead of turning into a schedule nobody asked for.

Six- and seven-field patterns are rejected on purpose: croner reads the extra leading field
as seconds, so a stray sixth field silently changes the meaning of the whole expression —
`0 5 * * * *` becomes "at second 0 of minute 5 of every hour", 24 syncs a day instead of
one.

### The scheduler's initial state comes from one function

`initialState()` in `src/scheduler.js`

The twelve fields were written out twice — once for the initial value, once in
`__resetForTests` — and the copy in the reset had already drifted. A field added to one and
not the other leaks between test cases in a way that shows up as an unrelated failure.
`pid` is excluded on purpose: it is the process's, not the run's, and resetting it to a
different value would be a lie about which process wrote the state file.

### The shutdown handler has no cleanup step

`gracefulShutdown()` in `src/index.js`

There was an "add any cleanup logic here" placeholder wrapped in a try/catch around a single
log call, so the catch was unreachable. A sync owns nothing this handler could release more
safely than process exit does: the Actual Budget connection is closed by
`getAccountBalances` before it returns, and an interrupted one is inside a native
better-sqlite3 call that will not unwind on request. What the handler has to get right is
exiting exactly once and flushing the log first.

### The Actual Budget connection is closed in `finally`

`getAccountBalances()` in `src/actualBudget.js`

`api.shutdown()` used to be the last statement of the `try` block, so every path that threw
after `init()` — a failed budget download, a rejected balance, an account name that did not
validate — left the server connection and the local SQLite handle open until the process
exited. Under the scheduler that process is a fork whose exit is not instant.

### The TLS floor is process-wide

`src/config/tls.js`

The hardened `https.Agent` in `src/ghostfolio.js` only covers the Ghostfolio leg of the
egress: `@actual-app/api` opens its own connections and never sees that agent, so the
documented "TLS 1.2 minimum" control covered half the traffic. `tls.DEFAULT_MIN_VERSION` is
the value Node uses whenever a caller does not pass `minVersion`, so it reaches axios,
undici/fetch and the Actual Budget client alike.

Node's own default is already TLSv1.2, so this pins the floor rather than raising it — the
point is that it can no longer drift with a Node upgrade or a dependency that builds its own
agent.

### There is no cipher allowlist

`TLS_MIN_VERSION` / `TLS_MAX_VERSION` in `src/config/constants.js`

The previous list permitted only ECDHE-RSA suites for TLS 1.2, which fails the handshake
outright against a server holding an ECDSA certificate — Let's Encrypt ECDSA and Cloudflare
both issue them. Its TLS 1.3 entries were inert, because Node's `ciphers` option governs TLS
1.2 and below only (TLS 1.3 needs `ciphersuites`, which Node does not expose). Node's
default suite list is already modern and drops the weak suites, so pinning bought nothing
and broke real deployments.

### The image ships no package manager

`Dockerfile`

Trivy scans the whole filesystem, and the npm that ships in `node:lts-alpine` vendors its
own dependency tree: `tar`, `brace-expansion`, `ip-address` and `undici` there accounted for
every fixable CRITICAL/HIGH finding in the image, while the application's own production tree
was clean. Updating the base image does not fix it — the pinned digest is already the current
`node:lts-alpine` — and `apk upgrade` cannot touch npm, which is not an apk package.

Nothing needs them at runtime: the entrypoint is `node`, the healthcheck is `node`, and the
scheduler forks `process.execPath`. They are removed in the same layer that used them, so
the bytes never enter the image at all.

`package.json` also used to carry an `allowScripts` block — @lavamoat/allow-scripts
configuration for a package that was never installed, so it named three permitted packages
while every dependency in the tree ran its install scripts unimpeded. `--ignore-scripts` is
the control that block described.

### Application code is root-owned in the image

`Dockerfile`

It was `COPY --chown=nodejs:nodejs . .`, which let a compromised sync or a malicious
dependency rewrite `src/` and persist across runs.

### `docker-compose.yml` points at `:latest`

It said `:1.0.0`, with a comment about preferring a released tag. The reasoning was sound and
the tag did not exist: CI publishes `:latest` and `:<commit-sha>` and nothing else, so
`docker compose up -d` on a clean host failed with "manifest unknown" rather than starting
anything.

The argument for pinning stands — a restart otherwise rolls out whatever was published most
recently — so the file records the tag that is really there: `niqck/ghostbudget:<sha>`, the
full 40-character SHA. `docker inspect` reports it as
`org.opencontainers.image.revision`.

### `ACTUAL_BUDGET_DATA_DIR` is pinned to the volume mount

`docker-compose.yml`

`.env.example` suggested a placeholder path, and the old entrypoint skipped its directory
check silently when that path did not exist. Actual Budget then wrote to a location that was
not persisted, and every run started over.

---

## Tooling

### Renovate replaced Dependabot, and took a privileged workflow with it

`renovate.json`

Two bots watching the same manifests open two PRs per update, so `.github/dependabot.yml`
went when `renovate.json` arrived. Dependabot _security_ updates were kept at first, since
those are a repository setting rather than a config file and so survived the file's removal
— but keeping them meant keeping `.github/workflows/dependabot-auto-merge.yml`, and that is
what settled it.

That workflow ran on `pull_request_target` and requested `contents: write` and
`pull-requests: write` in order to approve and merge. It was written carefully — no checkout
of PR head, the author gated on `dependabot[bot]`, and a `package-ecosystem == 'npm'` clause
that had to be added in all three expression sites because Dependabot reports github-actions
and docker updates as a bare `direct`, which `startsWith(…, 'direct')` does not exclude.
Renovate's `platformAutomerge` reaches the same outcome by handing the merge to GitHub, with
no workflow, no elevated scopes and no `pull_request_target`. A privileged workflow removed
is worth more than the integration it served, so both went.

The policy it enforced is intact in `renovate.json`, and stated rather than implied:
`automerge: false` appears explicitly on the `dockerfile` and `github-actions` managers
instead of relying on no rule having matched them. Neither reaches production through the
application's dependency tree — action code runs in CI with that job's scopes, and the
digest is the deployed artifact.

Two controls have no Dependabot equivalent and are new rather than ported.
`minimumReleaseAge: 3 days` on npm defends against the supply-chain pattern where a
compromised release is published, installed by everything that updates within the hour, and
yanked the same day; it is explicitly lifted for `vulnerabilityAlerts`, which exist to fix
old versions rather than adopt new ones. And `osvVulnerabilityAlerts` widens detection past
GitHub's own advisory database, which is what makes dropping Dependabot's security updates a
change of supplier rather than a loss of coverage.

The one thing this cannot do from a config file: Dependabot security updates have to be
turned off in the repository settings, or every security PR arrives twice.

### ESLint's recommended rules were never running

`eslint.config.js`

The config spread `js.configs.recommended` into a config object and then declared its own
`rules:` key in the same object literal — which silently overwrites the spread's `rules`. So
`eslint:recommended` was configured, appeared to be in force, and contributed nothing: a
probe file with a duplicate object key, unreachable code and an undefined global reported
only the one rule the config listed itself.

`eslint-plugin-security` had the same shape of failure for a different reason: it was a
devDependency, it was named in the CI job title, and it was listed in `SECURITY.md` as an
implemented control — but it was never registered in the config, so `npm run lint` exited 0
having run none of its 14 rules.

The recommended rules are now spread _inside_ the `rules` object, and the security plugin's
recommended config is a config-array entry of its own. Three related points: flat config
reads no `.eslintignore` and ignores only `node_modules` by default, so `coverage/` needs an
explicit `ignores` entry; `sourceType` read `module`, which is a different language from the
CommonJS these files are written in; and `--ext .js` is redundant under flat config, so the
npm scripts no longer pass it.

`@typescript-eslint` and `jsdoc` were also configured for a codebase with no TypeScript and
no JSDoc gate, and are gone from `devDependencies`.

### Four mock mechanisms were doing the work of two

`jest.config.js`, `jest.setup.js`

`restoreMocks: true` makes Jest call `restoreAllMocks()` before every test. The three
`jest.spyOn(console, …)` calls in `jest.setup.js` were installed at module scope, so they
covered the first test of each file and were stripped off before every one after it — two
suites had noticed and re-installed their own copies in their own `beforeEach`. Installed
from a setup-file `beforeEach` they survive, because Jest's internal restore runs before the
user hooks do.

`clearMocks` was also set alongside `resetMocks`, which subsumes it: a reset clears the calls
as well as the implementation. And there was an explicit `beforeEach(() => jest.clearAllMocks())`
on top of both.

### No test may open a socket

`jest.setup.js`

The suites point at `http://localhost:3333`, which is Ghostfolio's own default port, so a
test missing an interceptor did not fail — it sent a real balance PUT to whatever was
listening on the developer's machine. `nock.disableNetConnect()` also makes every "no
request was sent" assertion load-bearing: without it, a scope's `isDone() === false` only
proves nock did not serve the request, not that nothing was sent.

The `uuid` package used to be mocked here too, because it ships as ESM and Jest could not
load it. Correlation IDs now come from `crypto.randomUUID()`, which needs neither the mock
nor a `transformIgnorePatterns` entry.

### One environment fixture for the suites

`tests/helpers/env.js`

`validateEnvironment` validates the whole application schema at once, so a test about Actual
Budget still needs the Ghostfolio variables present and vice versa. Four suites each wrote
out their own copy of the same six assignments, with the token UUID repeated verbatim in
each — six lines to keep in step every time the schema gains a required variable.

It lives under `tests/helpers/` because Jest's default `testMatch` would collect a
`tests/env.js` as a suite with no tests in it.
