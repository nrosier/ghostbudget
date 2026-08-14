# GhostBudget

GhostBudget is a Node.js application that synchronizes account balances between [Actual Budget](https://github.com/actualbudget/actual) and [Ghostfolio](https://github.com/ghostfolio/ghostfolio). It automatically fetches your account balances from Actual Budget and updates the corresponding accounts in Ghostfolio. Big thanks to authors and contributors from both projects!

## Features

- Automatic authentication with both Actual Budget and Ghostfolio
- Configurable account mapping between the two systems
- Automatic balance conversion from Actual Budget's format to Ghostfolio's format
- Detailed logging for monitoring and troubleshooting, with no balance values in it
- Refuses rather than guesses: an error leaves the previous balance in place
  instead of overwriting it — see
  [what is written, and when it is not](#what-is-written-and-when-it-is-not)
- `DRY_RUN=true` to resolve every mapping and report without writing

## Prerequisites

- Node.js (v14 or higher recommended)
- An Actual Budget server instance
- A Ghostfolio instance
- Access tokens/credentials for both services

The script will:

1. Fetch account balances from Actual Budget
2. Read and validate `config.json`
3. Authenticate with Ghostfolio and fetch the current account list
4. Resolve every mapping to the write it describes, sending nothing
5. Update the balances that need it
6. Read the balances back and confirm each one is the value that was sent

## Installation

1. Clone the repository:

```bash
git clone https://github.com/johnkrzywanek/ghostbudget.git
cd ghostbudget
```

2. Install dependencies:

```bash
npm run install:ci
```

Dependency install scripts are denied by default and `better-sqlite3` is then
rebuilt by name, because `@actual-app/api` loads it natively. A plain
`npm install` works but runs the install scripts of every package in the tree;
`npm run install:prod` does the same as `install:ci` without dev dependencies.

3. Create configuration files:

```bash
cp .env.example .env
cp config.json.example config.json
```

4. Edit the `.env` file with your credentials and settings
5. Edit the `config.json` file with your account mappings

## Configuration

### Environment Variables (.env)

All of these are validated at startup, and the process refuses to run rather than
starting with a configuration that cannot work.

- `ACTUAL_BUDGET_URL`: URL of your Actual Budget server. See
  [transport security](#transport-security) for when plain `http://` is accepted.
- `ACTUAL_BUDGET_PASS`: Your Actual Budget server password. **Minimum 8
  characters** — enough to reject an empty or placeholder value.
- `ACTUAL_BUDGET_SYNC_ID`: Your budget's sync ID
- `ACTUAL_BUDGET_DATA_DIR`: Directory for Actual Budget data. Must be an absolute
  path to an existing, writable directory; the container sets this to the
  `/actual-budget` volume mount.
- `GHOSTFOLIO_URL`: URL of your Ghostfolio instance. See
  [transport security](#transport-security) for when plain `http://` is accepted.
- `GHOSTFOLIO_TOKEN`: The anonymous-user security token from Ghostfolio, which is
  a UUID. **Minimum 16 characters**, which catches a truncated or half-pasted
  token before it becomes a run of failed authentications.
- `DRY_RUN` (optional, default off): Resolve every mapping, report what would
  change, and write nothing to Ghostfolio. Worth one run after editing
  `config.json` — the only thing this tool does to Ghostfolio is overwrite
  account balances.
- `GHOSTBUDGET_LOG_DIR` (optional): Where to write log files. Defaults to
  `<app root>/logs`, resolved absolutely rather than against the working
  directory. Set this if the app root is not writable.
- `CRON_TASK`: Schedule for the container's built-in scheduler (Docker only).
  A five-field cron expression such as `0 5 * * *`, or one of `@hourly`,
  `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually`.
  Six- and seven-field expressions are rejected: an extra leading field is read
  as seconds, so `0 5 * * * *` would run hourly rather than daily.

### Transport security

Both URLs carry a credential on every run — the Actual Budget password and the
Ghostfolio security token. Which schemes are accepted depends on the **host**, not
on `NODE_ENV`:

- Plain `http://` is accepted only where the traffic cannot leave a local network:
  `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  IPv6 loopback / `fc00::/7` / `fe80::/10`, a `.local` or `.internal` name, or a
  single-label name such as a Docker Compose service (`http://actual_server:5006`).
  This is the normal Docker deployment and it is not warned about.
- Any other host **must** be `https://`, in every environment. The process refuses
  to start otherwise and records a security event, because the alternative is
  sending a password across a network in the clear.

Earlier versions gated this on `NODE_ENV=production`, which was wrong in both
directions: the shipped image sets `NODE_ENV=production`, so the documented
Compose setup could not start, while a run with `NODE_ENV` unset would happily
send credentials in plaintext to a host on the internet.

### Account Mapping (config.json)

The `config.json` file maps accounts between Actual Budget and Ghostfolio. Example structure:

```json
{
  "accounts": [
    {
      "ghostfolioName": "Exact name of account in Ghostfolio",
      "actualBudgetName": "Exact name of account in Actual Budget",
      "currency": "EUR"
    }
  ]
}
```

- `ghostfolioName` / `actualBudgetName`: must match the account names in both
  systems **exactly**. A name that matches more than one account in either system
  is refused rather than resolved by picking the first match — rename one of the
  accounts so the mapping addresses exactly one.
- `currency`: **required**, an ISO 4217 code such as `EUR` or `USD`. Neither API
  states the currency of an Actual Budget balance, so you declare it here and it
  is compared against the Ghostfolio account's currency. A mismatch fails that one
  account and the rest of the sync continues. Nothing is converted: `factor` is
  not an exchange rate, and using it as one freezes a rate into the config where
  it goes stale silently.
- `factor` (optional, default `1`): a positive multiplier applied to the balance.

> **Upgrading**: `currency` was previously absent. An existing `config.json`
> without it will fail validation at startup, before anything is written — add the
> code each mapped Ghostfolio account is denominated in.
>
> **Mapping a brokerage account**: a Ghostfolio account's `balance` is its **cash**
> balance; the account's total value is that cash _plus_ its holdings. Writing a
> brokerage total into `balance` therefore counts the holdings twice. Map cash
> accounts (current, savings) and leave accounts whose value comes from holdings to
> Ghostfolio.

## Usage

### Running the Sync

You can run the synchronization with different log levels:

```bash
# Normal operation (info level logs)
npm run sync

# With debug information
LOG_LEVEL=debug npm run sync

# Only show errors
LOG_LEVEL=error npm run sync
```

### Log Levels

- `error`: Only logs errors
- `warn`: Logs errors and warnings
- `info`: Normal operational messages (default)
- `debug`: Detailed debugging information

### Log Files

Logs are written to `GHOSTBUDGET_LOG_DIR`, or to `<app root>/logs` if it is not
set. The path is absolute either way, so running the sync from a subdirectory or
under a service manager with a different working directory still puts the logs in
one place.

- `combined.log`: Contains all logs
- `error.log`: Contains only error logs
- Console: Shows colored output for development

Both files rotate at 10 MB, keeping 5 generations. Log files never contain
passwords, access tokens, account balances, or stack traces — in any environment.
They do contain account names, which are treated as non-sensitive identifiers.

### Which build wrote a log line

Every record carries `version` (from `package.json`) and `commit`, and the record
each run writes at startup adds the full build string and the build time:

```json
{
  "message": "Starting sync process...",
  "version": "1.0.0",
  "commit": "079da7b",
  "build": "1.0.0+20260814T140004Z.079da7b",
  "built_at": "2026-08-14T14:00:04Z"
}
```

`build` is [SemVer 2.0.0 build metadata](https://semver.org/#spec-item-10): the part
after the `+` carries no precedence, so this is still version `1.0.0` to anything
that compares versions, while the string itself says which commit it is and when it
was built. The timestamp is in ISO 8601 _basic_ format there because build metadata
allows only `[0-9A-Za-z-]`, so the colons of `14:00:04` would make it invalid;
`built_at` is the same instant in the extended format.

The commit and the build time cannot be worked out at runtime — `.git/` is excluded
from the image and there is no git binary in it — so the image build stamps them in
as two build arguments:

```bash
docker build \
  --build-arg GHOSTBUDGET_COMMIT="$(git describe --always --dirty)" \
  --build-arg GHOSTBUDGET_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
```

These are inputs to `docker build`, **not** settings to put in `.env` — a value left
in an environment would outlive the build it described. The published images set
both from CI, and the same values become the `org.opencontainers.image.revision` and
`.created` labels, so `docker inspect` answers the question without a running
container:

```bash
docker inspect --format '{{json .Config.Labels}}' niqck/ghostbudget:latest
```

Anything unstamped is reported as such rather than guessed. A plain `docker build`
or a bare `npm run sync` yields `1.0.0+dev` and no `commit` field; a value that is
not a hex object name is discarded rather than logged, because a wrong commit names
a tree the running code did not come from. A build made from a modified working
tree — `git describe --dirty` — is marked `1.0.0+20260814T140004Z.079da7b.dirty`, with
`"dirty": true` on every record.

## Automated Execution

### Using Docker (recommended)

The container has its own scheduler — there is no `cron` inside the image and no
host crontab to maintain. `docker compose up -d` is all that is needed:

```bash
cp .env.example .env          # fill in credentials
mkdir -p config && cp config.json.example config/config.json
docker compose up -d
docker compose logs -f
```

On startup the scheduler validates `CRON_TASK` and `ACTUAL_BUDGET_DATA_DIR` and
logs the next three run times, so a mistyped schedule is visible immediately
rather than after a night of nothing happening. Each run is a separate process,
so a failed sync cannot affect the next one, and runs never overlap.

Check the container's health with:

```bash
docker inspect --format '{{.State.Health.Status}}' ghostbudget
docker exec ghostbudget node src/healthcheck.js
```

The health check reports on the scheduler, not on the last sync's outcome: a sync
that fails because Actual Budget or Ghostfolio is unreachable is a problem to
read in the logs, not a reason to restart the container.

### Using Cron

Add this to your crontab to run it automatically:

```bash
# Run every hour
0 * * * * cd /path/to/ghostbudget && LOG_LEVEL=info /usr/local/bin/npm run sync
```

### Using Systemd

Create a service file (`/etc/systemd/system/ghostbudget-sync.service`):

```ini
[Unit]
Description=Sync Actual Budget with Ghostfolio
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/path/to/ghostbudget
Environment=LOG_LEVEL=info
ExecStart=/usr/local/bin/npm run sync
User=youruser

[Install]
WantedBy=multi-user.target
```

Create a timer file (`/etc/systemd/system/ghostbudget-sync.timer`):

```ini
[Unit]
Description=Run Ghostbudget sync every hour

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Unit=ghostbudget-sync.service

[Install]
WantedBy=timers.target
```

Enable and start the timer:

```bash
sudo systemctl enable ghostbudget-sync.timer
sudo systemctl start ghostbudget-sync.timer
```

### Balance Conversion

The application automatically handles balance conversion between the two systems:

- Actual Budget stores balances as integers (e.g., 100012 for $1,000.12)
- GhostBudget converts these to decimal format before sending to Ghostfolio (e.g., 1000.12)

## What is written, and when it is not

The only thing this tool changes in Ghostfolio is the `balance` field of the
accounts named in `config.json`. It creates nothing, deletes nothing, and touches
no account that is not mapped. Because a wrong balance is worse than a missing
one, a run is arranged so that an error leaves the previous value in place rather
than replacing it with a guess.

A sync resolves **every** mapping first and writes only afterwards, so a check that
spans the whole mapped set can exist before the first write happens:

- **Nothing is sent if the configuration cannot be carried out.** `config.json` is
  read and validated before authenticating, so a typo does not exchange
  credentials first. Two mappings pointing at the same Ghostfolio account, an
  account name matching more than one account in either system, a currency that
  disagrees with the Ghostfolio account, or a balance that is not a finite number
  of plausible magnitude — each of these fails its mapping, and the run reports a
  non-zero exit at the end.
- **A run in which every mapped account reads zero writes nothing at all.** One
  zero is a real balance and is written normally. All of them at once is what a
  budget that has not finished syncing looks like, or a wrong
  `ACTUAL_BUDGET_SYNC_ID` pointing at an empty budget — none of which raise an
  error of their own, so the run would otherwise overwrite real balances with
  zeros and report success.
- **A balance that has not moved is not rewritten.** Every write is an opportunity
  to store the wrong number, so an account whose Ghostfolio balance already matches
  is skipped. On a typical run this skips most of them.
- **Every write is read back.** Once the writes are done, the account list is
  fetched again and each written balance compared with what was sent. If Ghostfolio
  is not holding the value that was sent, that account fails rather than being
  reported as synced — an HTTP 2xx says the request was accepted, which is not the
  same claim. If the read-back itself cannot be made, the run reports
  `confirmed` below `written` rather than either failing or claiming confirmation.
- **One bad mapping does not cost the others their sync.** Each failure is
  recorded, the remaining accounts are still processed, and the run then exits
  non-zero with a summary naming how many failed.
- **The run reports what it did, not what it saw.** The completed-sync audit record
  carries `mapped`, `resolved`, `changed`, `written`, `confirmed`, `unchanged` and
  `failed`, so "nothing needed writing tonight" and "two balances were stored" are
  distinguishable after the fact. A partially failed run records the same counts.

No balance value appears in any log line, error message, or audit record — not the
value read, the value sent, or the value already stored. Error messages name the
account and the limit that was exceeded, never the number that exceeded it. Both
values are visible in Ghostfolio's own UI, which is not a log file on a mounted
volume.

`DRY_RUN=true` runs everything above and stops short of the writes.

## Development

### Checks

```bash
npm run lint            # ESLint, including eslint-plugin-security; warnings fail
npm run lint:fix        # …and fix what can be fixed automatically
npm run format          # Prettier
npm test                # Jest
npm run test:coverage   # Jest with the coverage thresholds enforced
```

CI runs `npm run test:coverage` rather than `npm test`, because Jest's coverage
thresholds only engage when coverage is collected. If you add a module, expect the
thresholds in [jest.config.js](jest.config.js) to hold you to covering it.

`npm run lint` uses `--max-warnings=0`. `eslint-plugin-security` reports at warning
level, so without that flag its findings print and the build passes anyway.

### Adding New Features

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run lint` and `npm run test:coverage`
5. Submit a pull request

## Troubleshooting

Common issues and solutions:

1. **Connection Issues**
   - Verify your Actual Budget and Ghostfolio servers are running
   - Check URLs in `.env` file
   - Verify network connectivity

2. **Authentication Errors**
   - Verify your access tokens/credentials
   - Check if tokens have expired
   - Ensure proper permissions are set

3. **Account Mapping Issues**
   - Verify account names match exactly
   - Check for typos in config.json
   - Ensure accounts exist in both systems
   - `Ambiguous mapping: N accounts are named X` — the name matches more than one
     account, so the mapping does not identify one. Rename one of them.
   - `Currency mismatch for account X` — `currency` in `config.json` disagrees with
     the Ghostfolio account. Correct whichever is wrong; the tool does not convert.

4. **`Refusing to sync: all N resolved account(s) report a zero balance`**
   - Nothing was written. Check `ACTUAL_BUDGET_SYNC_ID`, and that the budget has
     finished syncing on the Actual Budget server — a budget that downloaded
     without applying its sync messages reports every account as empty.

5. **`Ghostfolio stored a different balance than was sent`**
   - The write was accepted, but reading the account back afterwards returned a
     different value. Read the account in Ghostfolio's UI before re-running;
     something between this tool and the database changed the value.

6. **`confirmed` is lower than `written` in the logs**
   - Every write was accepted, but the balances could not all be read back — either
     the confirming request failed, or an account was no longer in the list. The
     values were most likely stored; they are simply unverified. If it persists, the
     account list is the thing to look at.

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you encounter any issues or need support, please create an issue in the GitHub repository.
