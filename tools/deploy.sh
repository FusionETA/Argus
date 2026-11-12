#!/usr/bin/env bash
# Deploy a new Argus check to the live box: fast-forward /root/argus to origin/main
# and append ONE cron line for it. Never edits or removes existing cron lines, and
# never touches the AltomateHR jobs.
#
# Usage: tools/deploy.sh <app>/<action> "<min> <hour> <dom> <mon> <dow>" [--dry-run]
#   e.g. tools/deploy.sh myapp/login-check "15 9 * * 1-5" --dry-run
# Times are MYT (server tz). --dry-run shows what would change and changes nothing.
set -euo pipefail

LIVE="${ARGUS_LIVE:-/root/argus}"   # override only for testing against a sandbox copy
ACTION="${1:?usage: deploy.sh <app>/<action> \"<cron schedule>\" [--dry-run]}"
SCHED="${2:?usage: deploy.sh <app>/<action> \"<cron schedule>\" [--dry-run]}"
DRY="${3:-}"
die() { echo "deploy: $*" >&2; exit 1; }

[[ "$ACTION" =~ ^[a-z0-9-]+/[a-z0-9-]+$ ]] || die "action must be <app>/<action> (lowercase, digits, dashes)"
APP="${ACTION%%/*}"
[[ "$APP" != altomatehr ]] || die "AltomateHR jobs are managed by hand, not by this script"
read -r -a F <<< "$SCHED"
[[ ${#F[@]} -eq 5 ]] || die "schedule must have exactly 5 fields, got: '$SCHED'"
for f in "${F[@]}"; do [[ "$f" =~ ^[0-9*/,-]+$ ]] || die "bad schedule field '$f'"; done
[[ -z "$DRY" || "$DRY" == --dry-run ]] || die "unknown option '$DRY'"

# One deploy at a time (two colleagues editing the crontab at once would lose a line).
exec 9> /run/lock/argus-deploy.lock
flock -n 9 || die "another deploy is running"

cd "$LIVE"
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "$LIVE is not on main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "$LIVE has local changes to tracked files — sort those out first"
git fetch -q origin main
git merge-base --is-ancestor HEAD origin/main || die "$LIVE has commits not on origin/main — can't fast-forward"
git cat-file -e "origin/main:plugins/${ACTION}.js" 2>/dev/null || die "plugins/${ACTION}.js is not on origin/main — merge and push it first"

echo "== commits that will be pulled into $LIVE:"
git log --oneline HEAD..origin/main || true

# Every <APP>_* env var the app's code reads must be set (non-empty) in the live .env.
PREFIX="$(tr 'a-z-' 'A-Z_' <<< "$APP")_"
mapfile -t KEYS < <(git grep -ohE "process\.env\.${PREFIX}[A-Z0-9_]+" origin/main -- "plugins/${APP}" | sed 's/process\.env\.//' | sort -u)
missing=()
for k in "${KEYS[@]}"; do grep -qE "^${k}=.+" .env || missing+=("$k"); done
echo "== env keys read by plugins/${APP}: ${KEYS[*]:-(none found)}"
[[ ${#missing[@]} -eq 0 ]] || die "missing/empty in $LIVE/.env: ${missing[*]} (add them without pasting values into chat)"

CUR="$(crontab -l 2>/dev/null || true)"
grep -q '^ARGUS_NODE=' <<< "$CUR" || die "crontab has no ARGUS_NODE= line — not the expected Argus crontab"
if grep -qE "run\.sh ${ACTION}( |$)" <<< "$CUR"; then die "a cron line for ${ACTION} already exists:
$(grep -E "run\.sh ${ACTION}( |$)" <<< "$CUR")"; fi
LINE="${SCHED} ${LIVE}/run.sh ${ACTION}"
NEW="${CUR}
# ${ACTION} — added $(date '+%Y-%m-%d %H:%M %Z') by tools/deploy.sh. Log: ${LIVE}/logs/${APP}-${ACTION#*/}.log
${LINE}"

echo "== crontab change:"
diff <(echo "$CUR") <(echo "$NEW") || true

if [[ "$DRY" == --dry-run ]]; then
  echo "== dry run: nothing pulled, crontab unchanged"
  exit 0
fi

git merge -q --ff-only origin/main
BAK="$(dirname "$LIVE")/argus-crontab.bak-$(date +%Y%m%d-%H%M%S)"
echo "$CUR" > "$BAK"
echo "$NEW" | crontab -
crontab -l | grep -qxF "$LINE" || die "crontab install did not stick — previous crontab saved at $BAK"
echo "== deployed: $LIVE now at $(git log --oneline -1); cron line added; previous crontab saved at $BAK"
