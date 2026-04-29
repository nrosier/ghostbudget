#!/bin/sh
printenv | grep -v "no_proxy" > /app/project_env.sh
echo "$CRON_TASK . /app/project_env.sh; cd /app && /usr/local/bin/npm run sync >> /var/log/cron.log 2>&1" > /etc/crontabs/root
touch /var/log/cron.log
echo "GhostBudget scheduler gestart met schema: $CRON_TASK"
crond -l 2 && tail -f /var/log/cron.log
