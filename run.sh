#!/usr/bin/env bash
# Argus cron wrapper — runs a plugin action under a virtual X display and logs it.
# Usage: run.sh <app>/<action>   -> plugins/<app>/<action>.js, log logs/<app>-<action>.log
#        run.sh <action>         -> AltomateHR (plugins/altomatehr/<action>.js, logs/<action>.log),
#                                   kept for the original clockin | clockout | claims-check cron lines
set -euo pipefail

ACTION="${1:?usage: run.sh <app>/<action> | clockin|clockout|claims-check}"
if [[ ! "$ACTION" =~ ^[a-z0-9-]+(/[a-z0-9-]+)?$ ]]; then
  echo "run.sh: invalid action '${ACTION}' (expected <app>/<action>, lowercase letters, digits, dashes)" >&2
  exit 2
fi
cd "$(dirname "$(readlink -f "$0")")"

if [[ "$ACTION" == */* ]]; then
  SCRIPT="plugins/${ACTION}.js"
else
  SCRIPT="plugins/altomatehr/${ACTION}.js"
fi

# Node binary: override with ARGUS_NODE (e.g. a side-by-side /opt/node24/bin/node
# on hosts whose system node is too old for Playwright).
NODE="${ARGUS_NODE:-/usr/bin/node}"

mkdir -p logs
LOG="logs/${ACTION//\//-}.log"
TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"

# Retry: a failed run is run once more after ARGUS_RETRY_DELAY seconds (default
# 300) and alerts only if it fails again (core/report.js holds the first alert
# back). Scripts that change data opt out with an "argus:no-retry" line, so a
# half-finished action is never repeated.
ATTEMPTS=2
grep -q 'argus:no-retry' "$SCRIPT" 2>/dev/null && ATTEMPTS=1
DELAY="${ARGUS_RETRY_DELAY:-300}"
FIRST_FAILED_AT=""

run_once() {
  ARGUS_ATTEMPT="$1" ARGUS_ATTEMPTS="$ATTEMPTS" ARGUS_FIRST_FAILED_AT="$FIRST_FAILED_AT" \
    /usr/bin/xvfb-run -a "$NODE" "$SCRIPT" >> "$LOG" 2>&1
}

echo "===== ${ACTION} @ ${TS} =====" >> "$LOG"
# Capture the exit code instead of letting set -e abort, so failed runs still
# get their footer line; then pass the code through to cron.
RC=0
run_once 1 || RC=$?
if [[ "$RC" -ne 0 && "$ATTEMPTS" -gt 1 ]]; then
  FIRST_FAILED_AT="$(date '+%H:%M')"
  echo "----- ${ACTION} failed (exit ${RC}); retrying in ${DELAY}s -----" >> "$LOG"
  sleep "$DELAY"
  RC=0
  run_once 2 || RC=$?
fi
echo "===== ${ACTION} exit ${RC} @ $(date '+%H:%M:%S %Z') =====" >> "$LOG"
exit "$RC"
