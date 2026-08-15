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

# .npmrc comes along because it carries engine-strict=true: the image build is then held
# to the same Node floor as a developer's install rather than being the one place that
# floor is not checked. It must not be added to .dockerignore, or this COPY fails.
COPY package*.json .npmrc ./

# Install dependencies, denying install scripts by default.
#
# `--ignore-scripts` refuses arbitrary code from any transitive dependency at install
# time, and the one package that genuinely needs to compile is then built by name:
# better-sqlite3 (via @actual-app/api) is a native module with no prebuilt binary for
# Alpine's musl, so `npm rebuild` compiles it here against the virtual build-deps, which
# are removed in the same layer.
#
# The package managers are then deleted, in this same layer so the bytes never enter the
# image at all — the same reasoning as .build-deps above. They accounted for every
# fixable CRITICAL/HIGH Trivy finding in the image and nothing here needs them at
# runtime: the entrypoint is node, the healthcheck is node, and the scheduler forks
# process.execPath. See docs/decisions.md for why a base-image bump does not do it.
#
# Use the /opt/yarn-* glob: a base image bundling a different yarn patch version would
# otherwise leave yarn behind silently.
#
# To run a sync by hand in the container: docker exec <name> node src/index.js
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3 && \
    npm cache clean --force && \
    apk del .build-deps && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm

# Application code is copied root-owned, so it is read-only to the account the sync runs
# as: a compromised sync or a malicious dependency cannot rewrite src/ and persist across
# runs. See docs/decisions.md.
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

# Build identity, stamped in because it cannot be derived at runtime: .dockerignore
# excludes .git/, and there is no git binary in the image — the layer above deletes
# even the package managers. src/config/version.js turns these into
# `1.0.0+20260814T140004Z.079da7b` and refuses anything that is not a hex object
# name, so a wrong value reads as absent rather than naming a tree the code did not
# come from.
#
# Both default to empty, so a plain `docker build .` still produces a working image;
# it reports itself as `1.0.0+dev`. To stamp a local build:
#
#   docker build \
#     --build-arg GHOSTBUDGET_COMMIT="$(git describe --always --dirty)" \
#     --build-arg GHOSTBUDGET_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
#
# Declared here, after every COPY and RUN, so a new commit invalidates no cached
# layer: everything below this point is image metadata.
ARG GHOSTBUDGET_COMMIT=""
ARG GHOSTBUDGET_BUILT_AT=""
ENV GHOSTBUDGET_COMMIT=$GHOSTBUDGET_COMMIT \
    GHOSTBUDGET_BUILT_AT=$GHOSTBUDGET_BUILT_AT

# OCI annotations, so `docker inspect` answers "what is this and when was it built"
# without a running container. `revision` takes the full object name rather than the
# short one the logs use, which is what the spec asks for. No
# `org.opencontainers.image.version`: it would be a second copy of package.json's
# version, which is in the image and is the source the code reads.
LABEL org.opencontainers.image.title="ghostbudget" \
      org.opencontainers.image.description="Syncs Actual Budget account balances to Ghostfolio" \
      org.opencontainers.image.source="https://github.com/nrosier/ghostbudget" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="$GHOSTBUDGET_COMMIT" \
      org.opencontainers.image.created="$GHOSTBUDGET_BUILT_AT"

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/src/scheduler.js"]
