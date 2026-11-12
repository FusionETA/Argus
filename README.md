# Argus

FusionETA's unattended browser smoke-test bot. Each check is a headed Playwright
script that logs into an app, walks a journey and reports. Root's cron runs them on
weekdays on the `agents-s-2vcpu-4gb-sgp1` droplet. When a check fails, it alerts the
destinations in its `<APP>_NOTIFY`: Bitrix24, WhatsApp, email, Telegram, Slack, Teams,
Google Chat or any webhook, in any mix. Without that setting it uses the default Bitrix
chat. Successful runs only log.

**To add or change a check, ask Claude in a session on this repo.** The
`argus-new-test` skill (`.claude/skills/argus-new-test/SKILL.md`) handles the
whole flow: intake, read-only investigation, plan, script, test, deploy.

## Layout

| Path | What |
| --- | --- |
| `run.sh` | Cron wrapper: `run.sh <app>/<action>` runs `plugins/<app>/<action>.js` under `xvfb-run` and logs to `logs/<app>-<action>.log`. A bare `run.sh <action>` means AltomateHR (`logs/<action>.log`). |
| `core/browser.js` | Launches headed Chromium with a geolocation-granted context. |
| `core/guard.js` | `blockWrites(page)` aborts every POST/PUT/PATCH/DELETE after login, so read-only checks can't save anything. |
| `core/report.js` | `sendReportOnFailure(result, text, { app })`: always logs, and on failure alerts every destination in `<APP>_NOTIFY`. With no app or no `<APP>_NOTIFY`, it uses the default Bitrix chat. Channel setup: `.claude/skills/argus-new-test/notifications.md`. `ARGUS_NO_NOTIFY=1` suppresses all sends, for test runs. |
| `tools/notify.js` | `--app <app> --check` lists a check's alert destinations and missing credentials; `--test` sends a test alert to all of them. |
| `core/time.js` | `nowMYT()` for report timestamps. |
| `plugins/<app>/` | One folder per app: checks as `<action>.js`, helpers (incl. `login.js`) in `lib/`. |
| `tools/recon.js` | Read-only page inventory and screenshots, for planning a new check. |
| `tools/deploy.sh` | Fast-forwards `/root/argus` to `main` (running `npm ci` if dependencies changed), checks alert destinations, and appends one cron line. Runs under a lock and backs up the crontab. |
| `.claude/skills/argus-new-test/` | The workflow skill and a script template. It loads in any Claude Code session on this repo. |
| `org-plugin/argus/` | Small org-wide plugin (published on claude.ai). It points people from any session to a "FusionAI" + FusionETA/argus session. |

Work on Argus in a Claude Code session on the self-hosted **FusionAI** environment
with this repo. Sessions on the Anthropic-cloud environment can't reach the live box.

## The live box

- **Live checkout:** `/root/argus`, on `main`. Cron runs it, so don't edit it by hand;
  deploy with `tools/deploy.sh`.
- **Config:** `/root/argus/.env` (chmod 600, never committed). Keys are prefixed per app,
  see `.env.example`.
- **Node:** 24 at `/opt/node24/bin/node`, selected through the `ARGUS_NODE=` line at the top of
  root's crontab. The system `/usr/bin/node` is v18 and belongs to another service.
- **Timezone:** the server runs on `Asia/Kuala_Lumpur`, so cron times are MYT.
- **Pushes:** `/root/.ssh/argus_deploy_ed25519` is a deploy key with write access to this
  repo, used through each checkout's `core.sshCommand`.

## Current checks

| When (MYT, Mon–Fri) | Command | What |
| --- | --- | --- |
| 09:00 | `run.sh clockin` | AltomateHR: clock in the smoke account, then the read-only claims check |
| 18:00 | `run.sh clockout` | AltomateHR: clock out the smoke account |

`clockin` and `clockout` really change attendance on PROD, so never run them by hand.
`run.sh claims-check` is read-only and safe to run any time.

## Rules for every check

- **Read-only by default.** Stop before anything is saved, and use `blockWrites`.
  A check that changes data needs the app owner's approval, recorded in the commit
  message.
- **Test accounts only.**
- **Secrets stay out of chat**, commits, command lines and logs.
