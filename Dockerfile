# Node.js LTS on Alpine, pinned by digest rather than by tag.
#
# A tag is mutable: `node:lts-alpine` resolves to a different image over time, so
# two builds of the same commit are not the same image and a compromised upstream
# tag would be pulled silently. The digest below was resolved on 2026-08-13 and is
# Node v24.19.0 on Alpine 3.24.1.
#
# To update: docker pull node:lts-alpine && \
#            docker image inspect node:lts-alpine --format '{{index .RepoDigests 0}}'
FROM node:lts-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# tini becomes PID 1. It forwards SIGTERM/SIGINT to the scheduler so `docker stop`
# is acted on immediately instead of waiting out the grace period, and it reaps
# any process a sync leaves behind.
#
# Build tools are needed to compile better-sqlite3 (via @actual-app/api) and are
# installed as a virtual package so they can be removed in the same layer.
RUN apk upgrade --no-cache && \
    apk add --no-cache tini && \
    apk add --no-cache --virtual .build-deps python3 make g++ && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

COPY package*.json ./

# Install dependencies, denying install scripts by default.
#
# package.json used to carry an `allowScripts` block — @lavamoat/allow-scripts
# configuration for a package that was never installed, so it named three
# permitted packages while every dependency in the tree ran its install scripts
# unimpeded. `--ignore-scripts` is the control that block described: arbitrary
# code from any transitive dependency is refused at install time, and the one
# package that genuinely needs to compile is then built by name.
#
# better-sqlite3 (via @actual-app/api) is a native module with no prebuilt binary
# for Alpine's musl, so `npm rebuild` compiles it here against the virtual
# build-deps, which are removed in the same layer.
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3 && \
    npm cache clean --force && \
    apk del .build-deps

# Application code is copied root-owned, so it is read-only to the account the
# sync runs as. Previously this was `COPY --chown=nodejs:nodejs . .`, which let a
# compromised sync or a malicious dependency rewrite src/ and persist across runs.
COPY . .

# Only the paths the application must write to belong to nodejs:
# - /app/logs        Winston's file transports
# - /actual-budget   default Actual Budget data directory. A fresh named volume
#                    mounted here inherits this ownership from the image, so the
#                    container does not need a root phase to chown it.
RUN mkdir -p /app/logs /actual-budget && \
    chown nodejs:nodejs /app/logs /actual-budget && \
    chmod 750 /app/logs /actual-budget

# No root at runtime. The scheduler needs no privileges: it reads environment
# variables, writes logs, and forks the sync as itself.
USER nodejs

# Verifies the scheduler is alive and still ticking, rather than that a process
# exists. See src/healthcheck.js for why a failed sync is not unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/src/healthcheck.js"]

# Expose no ports (this is a scheduled job, not a server)
# EXPOSE directive intentionally omitted

# Set secure environment defaults
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    ACTUAL_BUDGET_DATA_DIR=/actual-budget

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/src/scheduler.js"]
