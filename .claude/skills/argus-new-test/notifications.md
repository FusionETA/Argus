# Argus alert channels

A check alerts every destination listed in `<APP>_NOTIFY` (comma-separated) in
`/root/argus/.env` when a run fails. Code: `core/report.js`. Check or test a setup
with `tools/notify.js --app <app> --check | --test`.

- **Destinations** (the `<APP>_NOTIFY` values) are not secret. Claude may add or edit that line.
- **Credentials** (tokens, passwords, webhook URLs) are secrets. The person adds them to
  `.env` themselves, over SSH or the DigitalOcean console. Never collect them in chat.
- **Sharing:** credentials without a prefix (`SMTP_HOST`, `SLACK_WEBHOOK_URL`, ...) are shared by all
  checks. `<APP>_`-prefixed copies override them for one check.
- **Default:** with no `<APP>_NOTIFY`, alerts go to the default Bitrix chat (`BITRIX_DIALOG_ID`).

| Channel | Destination in `<APP>_NOTIFY` | Credentials needed |
| --- | --- | --- |
| Bitrix24 | `bitrix:chat1234` (group chat), `bitrix:57` (DM to user 57) | `BITRIX_WEBHOOK_URL` (already set, shared) |
| WhatsApp (Wazzup) | `whatsapp:60123456789` | `<APP>_WAZZUP_API_KEY`, `<APP>_WAZZUP_CHANNEL_ID`: per app, there's no shared Wazzup account |
| Email (SMTP) | `email:ops@fusioneta.com` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`; optional `SMTP_PORT` (default 587), `SMTP_FROM` (default = user) |
| Telegram | `telegram:-1001234567890` (group), `telegram:123456789` (person) | `TELEGRAM_BOT_TOKEN` |
| Slack | `slack`, or `slack:<name>` | `SLACK_WEBHOOK_URL`, or `SLACK_WEBHOOK_URL_<NAME>` |
| Microsoft Teams | `teams`, or `teams:<name>` | `TEAMS_WEBHOOK_URL[_<NAME>]` |
| Google Chat | `googlechat`, or `googlechat:<name>` | `GOOGLECHAT_WEBHOOK_URL[_<NAME>]` |
| Generic webhook | `webhook`, or `webhook:<name>` | `WEBHOOK_URL[_<NAME>]` |

`<name>` lets one check post to several channels of the same kind, e.g.
`slack:ops, slack:sales` → `SLACK_WEBHOOK_URL_OPS`, `SLACK_WEBHOOK_URL_SALES`.

## Failure screenshots

When a run fails, Argus screenshots the page (`logs/screenshots/`, kept 30 days).
Bitrix (needs the webhook's `disk` scope, which Argus's default webhook has), email and
Telegram get the image itself. Slack, Teams, Google Chat, WhatsApp and webhooks get a line
naming the file on the server. If the image can't be attached, the text alert still goes
out, and the log line says why.

## Retries and recovery

Under cron, `run.sh` re-runs a failed check once after 5 minutes. Only a second failure
alerts, and that alert says it failed twice. Checks that change data opt out (an
`argus:no-retry` line) and alert on the first failure. While a check keeps failing,
it alerts **at most once a day** (MYT); later failures that day are only logged, and the
next day's alert adds "failing since …". A new failure after a recovery alerts straight
away. The first pass after a failure sends "✅ … is passing again" (Argus can't tell what fixed it)
to the same destinations. Test runs with `ARGUS_NO_NOTIFY=1` change none of this.

## Getting the IDs and credentials

### Bitrix24
- **Group chat:** open it in Bitrix in a browser. The address bar shows `IM_DIALOG=chat1234`
  (or `dialogId=chat1234`); use `chat1234`.
- **Person:** the number in their profile URL, `/company/personal/user/57/` → `57`.
- **Webhook membership:** Argus posts through an inbound webhook that belongs to one Bitrix user. **That
  user must be a member of every group chat** Argus posts to, so ask a chat admin to
  add them.
- **Another portal:** a different portal or posting user needs its own inbound webhook with the `im`
  scope (Bitrix → Developer resources → Inbound webhook), stored as
  `<APP>_BITRIX_WEBHOOK_URL`.

### WhatsApp (Wazzup)
- **Number format:** international, digits only (`60123456789`; `+60 12-345 6789` also works).
- **No shared account:** Argus has no company-wide Wazzup account. An app that wants
  WhatsApp alerts brings its own: its Wazzup API key as `<APP>_WAZZUP_API_KEY` and its
  WhatsApp channel's `channelId` (from Wazzup) as `<APP>_WAZZUP_CHANNEL_ID`. Both are
  secrets, so the person adds them on the box. Always confirm with `--test`.
- **24-hour rule:** if Wazzup rejects messages with a 24-hour-window or template error, the
  channel is a WhatsApp Business API one. Free-text alerts then only reach people who
  messaged that number in the last 24 hours, so use another channel.

### Email (SMTP)
Use a dedicated sender mailbox (e.g. `argus@` or `notifications@`), not a person's.
Common settings:

| Provider | `SMTP_HOST` | `SMTP_PORT` | Notes |
| --- | --- | --- | --- |
| Google Workspace | `smtp.gmail.com` | 587 | Needs an **App Password** (2-Step Verification on); the normal password is refused. |
| Microsoft 365 | `smtp.office365.com` | 587 | An admin must enable **Authenticated SMTP** for that mailbox. |
| Zoho Mail | `smtppro.zoho.com` (org) / `smtp.zoho.com` | 465 or 587 | |
| cPanel hosting | `mail.<domain>` | 465 or 587 | |

- **Ports:** 465 uses TLS from the start; 587 upgrades with STARTTLS.
- **`SMTP_FROM`:** should be the same mailbox or domain, otherwise it'll likely land in spam.
- **First email:** ask the person to check spam.

### Telegram
1. Create a bot with **@BotFather** (`/newbot`). It gives a token, which goes in
   `TELEGRAM_BOT_TOKEN` (secret).
2. **Group:** add the bot to the group, then send `/start@<BotName>` in it.
   **Person:** they open the bot and press Start.
3. Find the chat ID on the box. This prints IDs and names only, never the token:
   ```bash
   /opt/node24/bin/node --env-file=/root/argus/.env -e 'const r=await (await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`)).json(); for (const u of r.result||[]) { const c=(u.message||u.my_chat_member||{}).chat; if (c) console.log(c.id, c.type, c.title||c.username||c.first_name); }' --input-type=module
   ```
   Group IDs are negative (supergroups start with `-100`).

### Slack
In Slack, add the **Incoming Webhooks** app, choose **Add New Webhook to Workspace**,
then pick the channel. The URL (`https://hooks.slack.com/services/...`) is a secret.

### Microsoft Teams
In the channel, go to **⋯ → Workflows**, then pick **"Post to a channel when a webhook
request is received"**. Copy the URL it gives (secret). Argus sends an Adaptive Card,
which that workflow posts as-is. The old "Incoming Webhook" connectors are retired.

### Google Chat (Google Workspace only)
In the space, go to **Apps & integrations → Webhooks → Add webhook**. The URL contains a key
and token, so it's a secret.

### Generic webhook
Argus POSTs JSON `{ "source": "argus", "app", "subject", "text", "sentAt" }` to the
URL. Use it for n8n, Zapier, Make or an in-house endpoint.

## Troubleshooting `failed for ...` lines

| Error | Usual cause |
| --- | --- |
| `bitrix:chat…` → `ACCESS_ERROR` / `CHAT_ID_EMPTY` | Argus's webhook user isn't in that chat, or the ID is wrong. |
| `screenshot NOT attached: insufficient_scope` | The Bitrix webhook lacks the `disk` scope (needed for images). The text alert was sent. |
| `email:` → `Invalid login` / `535` | Wrong password; Gmail needs an App Password; M365 SMTP AUTH is disabled. |
| `email:` → timeout / `ECONNREFUSED` | Wrong host or port, or the provider blocks SMTP from servers. |
| `telegram:` → `400 chat not found` | The bot isn't in the group, nobody pressed Start, or the ID is wrong. |
| `telegram:` → `401` / `404` | Bad bot token. |
| `slack` / `teams` / `googlechat` → `404` / `403` | The webhook URL was deleted or mistyped. |
| `whatsapp:` → `4xx` | The app's Wazzup channel is blocked or isn't a WhatsApp channel, or the key or channel ID is wrong. |
