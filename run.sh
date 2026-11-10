#!/usr/bin/env bash
# Argus cron wrapper — runs a plugin action under a virtual X display and logs it.
# Usage: run.sh clockin | clockout | claims-check
set -euo pipefail

ACTION="${1:?usage: run.sh clockin|clockout|claims-check}"
cd "$(dirname "$(readlink -f "$0")")"

mkdir -p logs
LOG="logs/${ACTION}.log"
TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"

echo "===== ${ACTION} @ ${TS} =====" >> "$LOG"
/usr/bin/xvfb-run -a /usr/bin/node "plugins/altomatehr/${ACTION}.js" >> "$LOG" 2>&1
echo "===== ${ACTION} exit $? @ $(date '+%H:%M:%S %Z') =====" >> "$LOG"
