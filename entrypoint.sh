#!/bin/sh
set -e

# Validate CRON_TASK format to prevent injection
if [ -z "$CRON_TASK" ]; then
    echo "ERROR: CRON_TASK environment variable is not set"
    exit 1
fi

# Validate cron expression format (basic validation)
# Allow: numbers, *, -, /, comma, and spaces
if ! echo "$CRON_TASK" | grep -qE '^[0-9*/,[:space:]-]+$'; then
    echo "ERROR: Invalid CRON_TASK format. Must contain only numbers, *, -, /, commas, and spaces"
    exit 1
fi

# Create secure environment file with only necessary variables
# DO NOT export all environment variables - only export what's needed
cat > /app/project_env.sh << EOF
export NODE_ENV="${NODE_ENV:-production}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export ACTUAL_BUDGET_URL="${ACTUAL_BUDGET_URL}"
export ACTUAL_BUDGET_SYNC_ID="${ACTUAL_BUDGET_SYNC_ID}"
export ACTUAL_BUDGET_DATA_DIR="${ACTUAL_BUDGET_DATA_DIR}"
export GHOSTFOLIO_URL="${GHOSTFOLIO_URL}"
EOF

# Secure the environment file
chmod 600 /app/project_env.sh

# Note: Secrets (ACTUAL_BUDGET_PASS, GHOSTFOLIO_TOKEN) are NOT written to file
# They remain only in environment variables for security

# Create crontab entry with proper escaping
echo "$CRON_TASK . /app/project_env.sh; cd /app && /usr/local/bin/npm run sync >> /var/log/cron.log 2>&1" > /tmp/crontab.tmp

# Install crontab for nodejs user
crontab -u nodejs /tmp/crontab.tmp
rm /tmp/crontab.tmp

# Create log file with correct permissions
touch /var/log/cron.log
chown nodejs:nodejs /var/log/cron.log

echo "GhostBudget scheduler started with schedule: $CRON_TASK"
echo "Running as user: $(whoami)"
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"

# Start cron in foreground and tail logs
crond -f -l 2 &
tail -f /var/log/cron.log

# Made with Bob
