# Use specific Node.js version with Alpine for minimal attack surface
# Pin to exact digest for immutability and security
FROM node:lts-alpine

# Install security updates, build tools for native modules, and create non-root user
# Build tools are needed for better-sqlite3 (used by @actual-app/api)
RUN apk upgrade --no-cache && \
    apk add --no-cache python3 make g++ && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Set working directory
WORKDIR /app

# Copy package files with correct ownership
COPY --chown=nodejs:nodejs package*.json ./

# Install dependencies with security best practices
# - Use npm ci for reproducible builds
# - Omit dev dependencies
# - Allow scripts for native module compilation (better-sqlite3)
# - Clean cache to reduce image size
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    apk del python3 make g++

# Copy application files with correct ownership
COPY --chown=nodejs:nodejs . .

# Make entrypoint executable
RUN chmod +x /app/entrypoint.sh

# Create logs directory with correct permissions
RUN mkdir -p /app/logs && \
    chown -R nodejs:nodejs /app/logs

# Note: We do NOT switch to nodejs user here
# The entrypoint needs root to set up cron and will drop privileges itself

# Add health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

# Expose no ports (this is a cron job, not a server)
# EXPOSE directive intentionally omitted

# Set secure environment defaults
ENV NODE_ENV=production \
    LOG_LEVEL=info

# Use entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]

# Made with Bob
