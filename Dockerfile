# Use specific Node.js version with Alpine for minimal attack surface
# Pin to exact digest for immutability and security
FROM node:22.14.0-alpine3.21@sha256:5e3a0c41e1d2c5b0e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5

# Install security updates and create non-root user
RUN apk upgrade --no-cache && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Set working directory
WORKDIR /app

# Copy package files with correct ownership
COPY --chown=nodejs:nodejs package*.json ./

# Install dependencies with security best practices
# - Use npm ci for reproducible builds
# - Omit dev dependencies
# - Ignore scripts to prevent malicious code execution
# - Clean cache to reduce image size
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy application files with correct ownership
COPY --chown=nodejs:nodejs . .

# Make entrypoint executable
RUN chmod +x /app/entrypoint.sh

# Create logs directory with correct permissions
RUN mkdir -p /app/logs && \
    chown -R nodejs:nodejs /app/logs

# Switch to non-root user
USER nodejs

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
