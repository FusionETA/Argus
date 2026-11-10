#!/usr/bin/env bash
# Argus cron wrapper — runs a plugin action under a virtual X display and logs it.
# Usage: run.sh clockin | clockout | claims-check
set -euo pipefail

ACTION="${1:?usage: run.sh clockin|clockout|claims-check}"
cd "$(dirname "$(readlink -f "$0")")"

# Node binary: override with ARGUS_NODE (e.g. a side-by-side /opt/node24/bin/node
# on hosts whose system node is too old for Playwright).
NODE="${ARGUS_NODE:-/usr/bin/node}"

mkdir -p logs
LOG="logs/${ACTION}.log"
TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"

echo "===== ${ACTION} @ ${TS} =====" >> "$LOG"
# Capture the exit code instead of letting set -e abort, so failed runs still
# get their footer line; then pass the code through to cron.
RC=0
/usr/bin/xvfb-run -a "$NODE" "plugins/altomatehr/${ACTION}.js" >> "$LOG" 2>&1 || RC=$?
echo "===== ${ACTION} exit ${RC} @ $(date '+%H:%M:%S %Z') =====" >> "$LOG"
exit "$RC"
