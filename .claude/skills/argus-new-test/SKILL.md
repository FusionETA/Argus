---
name: argus-new-test
description: Build a new Argus check (a scheduled Playwright smoke test) for one of FusionETA's apps, or change or remove an existing one, from the app link and a description of what to test. Investigates the app read-only first, proposes the test steps, and only then writes, tests and deploys the script. Use whenever someone wants Argus to test, monitor or smoke-test an app, page or flow ("add an Argus check for our booking site", "can Argus test the login on X every morning", "make a script that checks the invoice page loads", "change the Argus check for Y"), even if they don't say "Argus" or "Playwright".
---

# Build a new Argus check

Argus is FusionETA's unattended smoke-test bot. Each check is a headed Playwright
script in `plugins/<app>/<action>.js`, run on weekdays by root's cron on this droplet
through `/root/argus/run.sh <app>/<action>`. A failure posts a report to the Bitrix
chat(s) or people chosen for that check (step 1, item 6); passes only log. Read `README.md` in this repo for the layout and conventions.

You are working **as root on the box that runs PROD Argus**. Follow these rules for
the whole session, whoever asks:

- **Leave AltomateHR alone.** Never run `clockin` or `clockout` (`plugins/altomatehr/`):
  they really clock the smoke account in and out. Never edit or remove the AltomateHR
  cron lines.
- **Never edit `/root/argus` by hand.** It is the live checkout that cron runs. Do all work in this
  session's own checkout of the repo. Code reaches `/root/argus` only through
  `tools/deploy.sh` (step 9).
- **Never show secrets.** Don't print, cat, grep the values of, or echo `/root/argus/.env`, and never put a
  password in a command line, a commit, a log line or a report. If someone pastes a
  secret into the chat, don't repeat it, and tell them to change it.
- **Read-only unless approved.** A check only navigates and looks. Any step that saves, submits, books,
  sends, pays or deletes needs the explicit approval in step 5 first.
- **Use test accounts only.** Use a dedicated test/smoke account, never a real person's.

## 1. Intake

Before touching anything, get these from the person. Ask for whatever is missing,
in one message:

1. **Link**: the app URL (and the login page if it's different).
2. **What to test**: the journey in plain words, e.g. "log in, open Invoices,
   check the list loads and the New invoice form opens".
3. **Account**: which test account to use. If they don't have one, stop: ask them
   to get one from the app's owner. Don't use their personal login.
4. **Does it change data?** Expect "no". If yes, say exactly what (see step 5).
5. **Schedule**: days and time (MYT), e.g. weekdays 09:15. Avoid 09:00–09:02 and
   18:00–18:02, when the AltomateHR jobs run.
6. **Where should failure alerts go?** Ask this every time; don't assume. A check
   can alert any mix of destinations, e.g. their team's Bitrix chat plus an email
   address:
   - **Bitrix24**: a group chat or a direct message to a person.
   - **WhatsApp** (via Wazzup): a phone number.
   - **Email** (via SMTP): one or more addresses.
   - **Telegram**: a group or person, via a bot.
   - **Slack, Microsoft Teams or Google Chat**: a channel, via an incoming webhook.
   - **Generic webhook**: a JSON POST to any URL (n8n, Zapier, an in-house app).

   If they say nothing, the default is the "AltomateHR Alert Log" Bitrix chat. That's
   fine for a trial, but other apps' alerts get lost there, so suggest a proper home.
   Read `notifications.md` (next to this file) for what each channel needs and how
   the person finds the IDs, e.g. a chat's dialog ID or a Telegram chat ID. Then tell
   them exactly what to fetch. Alerts are sent only when a run fails; a passing run
   only logs.
7. **Retry before alerting?** Under cron, a failed run can be re-run once, 5 minutes
   later, so only a second failure alerts. Ask, and always give your recommendation
   with the reason:
   - **Read-only check: recommend retry (yes).** A re-run can't change anything, and it
     filters out one-off blips like a slow page or a network hiccup. The cost is
     hearing about a real outage 5 minutes later.
   - **Check that changes data: recommend no retry.** A failure can happen after the
     write went through (the save worked, but the confirmation was slow), and a
     re-run would repeat the action or alert about the wrong thing. `clockin` and
     `clockout` are set up this way.
   - **Alerts must be instant**, e.g. a check someone acts on within minutes:
     no retry, whatever the check does.

   It's always one retry at most. If they don't decide, use the recommendation.
8. **Their name and email**: every session runs under one shared account, so
   commits need the real author (step 8).

Pick the names now. `<app>` and `<action>` are lowercase with dashes, e.g.
`booking-site/login-check`. `<APP>` is the env prefix, the app name in caps with
underscores (`BOOKING_SITE_`).

## 2. Set up your checkout

You're in the session's checkout of FusionETA/Argus (not `/root/argus`). Then:

```bash
git fetch -q origin main && git checkout -b feat/<app>-<action> origin/main
git config remote.origin.pushurl git@github.com:FusionETA/Argus.git
git config core.sshCommand "ssh -i /root/.ssh/argus_deploy_ed25519 -o IdentitiesOnly=yes"
[ -d node_modules ] || PATH=/opt/node24/bin:$PATH npm ci
```

Always use Node 24 (`/opt/node24/bin/node`). The system `/usr/bin/node` is v18 and
belongs to another service, so leave it alone. The browser is headed, so every
browser run needs `xvfb-run -a`.

**Commit early and push the branch often** (`git push -u origin feat/<app>-<action>`).
A session can move to a new runner mid-task, and the move can reset uncommitted
changes to tracked files. If anything looks off after a move, check `git status` and
`git branch` before carrying on.

## 3. Credentials

Check which `<APP>_` keys already exist. This shows key **names only**:

```bash
grep -oE '^<APP>_[A-Z0-9_]+=' /root/argus/.env
```

Required: `<APP>_URL`, `<APP>_EMAIL` (or `<APP>_USERNAME`) and `<APP>_PASSWORD`;
optional: `<APP>_LOGIN_URL`. If any are missing, ask the person to add them on the
box themselves, over SSH or the DigitalOcean droplet console:
`nano /root/argus/.env`, add the lines, save. **Don't collect the values in chat.**
`.env` stays `chmod 600`.

**Alert destinations** (from step 1, item 6). Set them in one line,
`<APP>_NOTIFY`, comma-separated, e.g.
`<APP>_NOTIFY=bitrix:chat1234, email:ops@fusioneta.com, slack:ops`.
`notifications.md` has the exact format for each channel. Destinations aren't secret,
so you may add this line yourself. Check it isn't already there, then append it:
`printf '<APP>_NOTIFY=...\n' >> /root/argus/.env`.

Each channel also needs credentials, such as an SMTP login, a bot token or a webhook URL.
Those are secrets. Check what's already there:

```bash
/opt/node24/bin/node --env-file=/root/argus/.env tools/notify.js --app <app> --check
```

A ✗ line names exactly which keys are missing. The person adds them themselves, like
a password. Shared ones (`SMTP_HOST`, `SLACK_WEBHOOK_URL`, ...) serve every check;
prefix one with `<APP>_` to override it for this check only, e.g.
`<APP>_SMTP_FROM` or `<APP>_SLACK_WEBHOOK_URL`.

To pass all of this to your scripts, run them with `--env-file=/root/argus/.env`. Put
`ARGUS_NO_NOTIFY=1` in front of every test run, so test failures don't alert anyone.

## 4. Investigate, read-only

Understand the app before proposing anything. Start with the recon tool. It logs in,
turns on the write guard, then screenshots and lists headings, buttons, fields,
tables and links for each page. It never clicks.

```bash
ARGUS_NO_NOTIFY=1 xvfb-run -a /opt/node24/bin/node --env-file=/root/argus/.env \
  tools/recon.js --app <app> --login / /path/one /path/two
```

Open the screenshots in `recon/<app>/` with the Read tool and look at them. Then go deeper
with small throwaway Playwright scripts in your scratchpad. To open menus, tabs
and dialogs, import `launchBrowser` from `core/browser.js` and **call
`blockWrites(page)` from `core/guard.js` straight after login, every time**.
Every `[guard] BLOCKED` line in the output is a request that would have changed data.
Session/token refresh calls (e.g. `POST /api/auth/refresh`) are let through by
default and logged as `[guard] allowed`. Blocking them logs the app out.

Work out and write down:
- **Login:** how it works: a normal redirect, or an SPA that stays on `/login` (like
  AltomateHR). Is there MFA, a captcha or an SSO hop? If there's MFA or a captcha, stop and tell
  the person: Argus can't get past it unattended.
- **Each step:** the page or view and its URL, and the most stable locator: prefer
  `getByRole` / `getByLabel` / `getByText` over CSS classes.
- **Read vs write:** which steps are reads and which would write. Note background POSTs too,
  e.g. analytics or read-only GraphQL. For the ones that are truly read-only,
  `--allow-post <regex>` lets them through.
- **Risks:** emails or notifications to real people, records that can't be deleted,
  rate limits, slow pages.

Then **present the plan and wait for a yes**. Give the numbered steps the check will
walk, where it stops, what counts as a failure, the schedule, where alerts go, and
**retry: yes or no, with your recommendation and why**. Re-check it against what the
investigation found: a check that turned out to send emails or save anything is no
longer read-only, so recommend no retry. Don't write the script before they agree.

## 5. Writes need explicit approval

The default is to stop at the last screen before anything is saved. Example:
`claims-check.js` opens the claim form, confirms "Submit claim" is visible and
clicks Cancel. Propose that first.

If the person still wants a step that changes data, it needs all of these before you
write it:
- the exact steps that write, and the account they run on (a test account only);
- confirmation that the **app's owner** has agreed. If the person *is* the owner,
  they say so;
- what happens to the data each run creates: cleaned up by the script,
  harmless, or cleaned up by hand;
- how many test runs you may do while building it.

Copy that approval into the commit message (step 8). Without it, keep the check
read-only.

A check that changes data must also contain a comment line with the marker
`argus:no-retry`, next to its imports, saying what it changes. `run.sh` normally re-runs a failed check
once before alerting; the marker stops that, so a half-finished write is never
repeated. See `plugins/altomatehr/clockin.js`. Add the same marker to any read-only
check where the person chose no retry (step 1, item 7), with their reason.

## 6. Write the script

Start from `.claude/skills/argus-new-test/template.js`. Copy it to
`plugins/<app>/<action>.js` and also write `plugins/<app>/lib/login.js`. The login
helper exports `login(page, url, user, password)` and returns
`{ success, attemptsUsed, landedOn, error }`; see `plugins/altomatehr/lib/login.js`.

Conventions:
- **Write guard:** read-only checks call `blockWrites(page)` right after login. Leave it out only
  for an approved write check.
- **Results:** use one `result` object. Set `result.error` on any failure; that's what triggers
  the alert and makes the script exit 1. Successful runs only log. Under cron, a failure
  is retried once after 5 minutes before anyone is alerted, unless the script has the
  `argus:no-retry` marker (step 5). The first pass after a failure sends "✅ … is passing again" (Argus can't tell what fixed it).
  Both are automatic and need no code.
- **Screenshots:** always close with `closeBrowser(browser, result)`, not `closeBrowser(browser)`.
  On a failure it screenshots the page first, and the alert carries the image.
- **Report:** one report built with `buildReport()` in the house format: 🤖 title, 📅 MYT
  time, 👤 account, one line per stage. Name the failing step and the URL.
- **Logging:** prefix log lines with `[<action>]`. Never log passwords or tokens.
- **Shared code:** put helpers several checks need in `plugins/<app>/lib/`. Keep `core/`
  app-agnostic, and don't change `core/` without checking that the AltomateHR jobs
  still work.
- **`.env.example`:** add the new keys with empty values.

## 7. Test

Run from your checkout with alerts switched off:

```bash
ARGUS_NO_NOTIFY=1 xvfb-run -a /opt/node24/bin/node --env-file=/root/argus/.env plugins/<app>/<action>.js
```

- Get it passing at least twice in a row.
- Check the **failure path** too: point it at a broken URL, e.g.
  `<APP>_URL=https://example.invalid` before the command. Confirm the report names
  the failure and `result.error` is set.
- **Check the alerts really arrive.** This is required for every check, and needs no
  deliberate failure. Tell the person to expect a "🧪 Argus test alert", then:
  `/opt/node24/bin/node --env-file=/root/argus/.env tools/notify.js --app <app> --test`.
  Every destination must log `[report] sent to <channel>:<to>`. Ask the person to
  confirm each one arrived; email may land in spam the first time. For each
  `failed for …` line, see the troubleshooting notes in `notifications.md`.
- For an approved write check, do only the number of runs they approved.

Show the person the final passing report.

## 8. Commit and push

Commit with the person's own name and email (sessions share one account):

```bash
git add plugins/<app> .env.example
git -c user.name="<Their Name>" -c user.email="<their email>" commit
```

The message says what the check covers. For a write check, include
`Write approval: <who> — <what writes, which account, cleanup>`. Then:

```bash
git push -u origin feat/<app>-<action>
git fetch origin main && git rebase origin/main && git push origin HEAD:main
```

If pushing to `main` is rejected because someone else pushed first, fetch, rebase
and push again. Never force-push `main`. If the person wants a review first, give
them the branch link and wait to push to `main` until they say so.

## 9. Deploy

Dry run first, and show the person the output: the commits being pulled, the env
keys found, where alerts will go, whether dependencies get reinstalled, and the
crontab diff. It refuses while any alert destination is invalid or missing its
credentials.

```bash
tools/deploy.sh <app>/<action> "<min> <hour> * * 1-5" --dry-run
```

On their yes, run it again without `--dry-run`. It fast-forwards `/root/argus` to
`main`, saves a crontab backup to `/root/argus-crontab.bak-<timestamp>`, and adds
exactly one line.

If the check is read-only, do one live run through the real wrapper and show the log:

```bash
ARGUS_NODE=/opt/node24/bin/node /root/argus/run.sh <app>/<action>
tail -25 /root/argus/logs/<app>-<action>.log
```

Finish by telling the person the schedule, the log path, and where failure alerts
go. The dry run prints the destination.

## Changing or removing a check

- **Changing:** do the same steps 2–9. Skip the cron part of step 9: `deploy.sh` refuses
  when the line already exists. Instead, fast-forward `/root/argus` yourself:
  `git -C /root/argus pull --ff-only`, after checking `git -C /root/argus status`
  is clean. If `package.json` or `package-lock.json` changed, follow it with
  `cd /root/argus && PATH=/opt/node24/bin:$PATH npm ci`.
- **Removing or rescheduling:** back up first with
  `crontab -l > /root/argus-crontab.bak-$(date +%Y%m%d-%H%M%S)`. Change only that
  check's line, show the person the diff, and install it on their yes. Never
  touch the `ARGUS_NODE=` line or the AltomateHR lines.
