---
name: argus
description: Entry point for Argus, FusionETA's unattended smoke-test bot that logs into our apps every weekday and alerts the Bitrix chat when something breaks. Use whenever someone wants a new automated/scheduled test, smoke test, monitor or Playwright script for one of our apps ("can Argus check our booking site every morning", "add a test for the invoice page", "make a bot that logs in and checks X"), wants to change or remove an Argus check, or asks how Argus works or why it alerted, even if they don't say "Argus".
---

# Argus: where the work happens

Argus runs on one DigitalOcean droplet (`agents-s-2vcpu-4gb-sgp1`). The live copy is
`/root/argus`; the code is the GitHub repo **FusionETA/Argus**. The full workflow for
building a check lives in that repo, in the `argus-new-test` skill.

## 1. Check you're in the right kind of session

Building, testing or deploying a check only works in a Claude Code session on the
**self-hosted "FusionAI" environment** with the **FusionETA/argus** repo, because
that's the only place with the live `.env`, the browser setup and cron. Run:

```bash
test -d /root/argus && ls /root/self-hosted-claude/FusionETA/argus/.claude/skills/argus-new-test/SKILL.md
```

- **Both exist:** you're in the right place. Read that `SKILL.md` and follow it from step 1
  (its rules apply in full), unless the `argus-new-test` skill is already loaded.
- **Either one is missing:** stop. Tell the person to start a new Claude Code session
  in the Claude app: **Code → new session → environment "FusionAI" → repository
  FusionETA/argus**. They should start that session with the app link and what they want tested. A
  session on the Anthropic-cloud "FusionETA" environment, or in Chat, can't reach Argus.
  Don't try to clone the repo and build the check here.

## 2. Things you can answer anywhere

- **What Argus is:** a scheduled, headed Playwright bot. Each check logs into an app with a
  test account and walks one journey. It is read-only unless an owner approved
  otherwise. Failures post a report to the Bitrix chat; passes only log.
- **Current checks:** listed in the repo's `README.md` ("Current checks").
- **Logs:** on the droplet, in `/root/argus/logs/<app>-<action>.log` (AltomateHR:
  `/root/argus/logs/<action>.log`).
- **Never** paste passwords or `.env` values into a chat. They're added on the box
  directly.

One session per person per check. Sessions share one Claude account, so
working in someone else's session mixes up their work.
