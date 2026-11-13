// Argus failure alerts.
//
// Always log the report locally (stdout -> logs/<...>.log). Only send it out when
// the run FAILED (result.error is set). Successful runs stay quiet.
//
// WHERE: a check passes { app: 'MY_APP' } (its env prefix) and lists its
// destinations in MY_APP_NOTIFY, comma-separated. Destinations aren't secret:
//   bitrix:chat1234        Bitrix24 group chat (or bitrix:57 = DM to user 57)
//   whatsapp:60123456789   WhatsApp via Wazzup (international number)
//   email:ops@example.com  email via SMTP
//   telegram:-1001234567   Telegram chat ID, via a bot
//   slack | teams | googlechat   incoming webhook, URL in SLACK_/TEAMS_/GOOGLECHAT_WEBHOOK_URL
//   webhook                generic JSON POST to WEBHOOK_URL (n8n, Zapier, in-house apps)
//   slack:ops              ...or a named one: URL in SLACK_WEBHOOK_URL_OPS (WEBHOOK_URL_OPS)
// Without MY_APP_NOTIFY (and for the AltomateHR scripts, which pass no app) the
// report goes to the default Bitrix chat(s) in BITRIX_DIALOG_ID.
//
// HOW: each channel's credentials (CHANNELS[].needs) come from env. A check can
// override any of them for itself by prefixing the key: MY_APP_SMTP_FROM,
// MY_APP_BITRIX_WEBHOOK_URL, ... Webhook URLs and tokens are secrets and are
// never logged.
//
// SCREENSHOTS: a failed run's screenshot (result.screenshot, taken by
// closeBrowser) is named in the text for every channel, and attached where the
// channel can carry a file: Bitrix (needs the webhook's "disk" scope; the text
// still goes out without it), email, Telegram.
//
// RETRY + RECOVERED: a failed run exits 1. When run.sh will retry it
// (ARGUS_ATTEMPT < ARGUS_ATTEMPTS) the first failure only logs; the alert goes out
// if the retry fails too. Each check's last final result is kept in
// logs/state/<check>.json: a failure while already failing adds "failing since",
// and the first pass after a failure sends "✅ recovered" to the same destinations.
// REPEAT LIMIT: while a check keeps failing it alerts at most once per day (MYT);
// later failures that day only log. "Recovered" is always sent.
//
// ARGUS_NO_NOTIFY=1 suppresses every send (use it for test runs); such runs also
// leave the stored state alone.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHECK_NAME, LOGS_DIR } from './check.js';
import { nowMYT } from './time.js';

const env = (app, key) => (app && process.env[`${app}_${key}`]) || process.env[key] || '';
// slack -> SLACK_WEBHOOK_URL, slack:ops -> SLACK_WEBHOOK_URL_OPS; the generic
// webhook channel uses WEBHOOK_URL / WEBHOOK_URL_<NAME>.
const hookKey = (ch, name) =>
  `${ch === 'webhook' ? '' : `${ch.toUpperCase()}_`}WEBHOOK_URL${name ? `_${name.toUpperCase().replace(/-/g, '_')}` : ''}`;

// One Bitrix REST call through the webhook; throws "<ERROR_CODE>: <description>".
async function bitrixCall(hook, method, params) {
  const res = await fetch(`${hook}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`${json.error || `HTTP ${res.status}`}: ${String(json.error_description || '').slice(0, 200)}`);
  }
  return json.result;
}

// Posts a file into the chat behind DIALOG_ID: find the chat's file folder,
// upload there, then commit it to the chat as a message.
async function bitrixAttach(hook, dialogId, file) {
  const chatId = dialogId.startsWith('chat')
    ? dialogId.slice(4)
    : (await bitrixCall(hook, 'im.dialog.get', { DIALOG_ID: dialogId })).id;
  const folder = await bitrixCall(hook, 'im.disk.folder.get', { CHAT_ID: chatId });
  const name = basename(file);
  const uploaded = await bitrixCall(hook, 'disk.folder.uploadfile', {
    id: folder.ID,
    'data[NAME]': name,
    'fileContent[0]': name,
    'fileContent[1]': readFileSync(file).toString('base64'),
    generateUniqueName: 'Y',
  });
  await bitrixCall(hook, 'im.disk.file.commit', { CHAT_ID: chatId, UPLOAD_ID: uploaded.ID });
}

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 300)}`);
  return body;
}

const CHANNELS = {
  bitrix: {
    valid: (to) => /^(chat\d+|\d+)$/.test(to),
    needs: () => ['BITRIX_WEBHOOK_URL'],
    async send(to, text, { app, screenshot }) {
      const hook = env(app, 'BITRIX_WEBHOOK_URL').trim().replace(/\/+$/, '');
      const id = await bitrixCall(hook, 'im.message.add', { DIALOG_ID: to, MESSAGE: text });
      if (!screenshot) return `message id ${id}`;
      try {
        await bitrixAttach(hook, to, screenshot);
        return `message id ${id}, screenshot attached`;
      } catch (err) {
        const hint = /scope/i.test(err.message) ? ' (the webhook needs the "disk" permission)' : '';
        return `message id ${id}; screenshot NOT attached: ${err.message}${hint}`;
      }
    },
  },
  whatsapp: {
    norm: (to) => to.replace(/[\s+()-]/g, ''),
    valid: (to) => /^\d{8,15}$/.test(to),
    needs: () => ['WAZZUP_API_KEY', 'WAZZUP_CHANNEL_ID'],
    async send(to, text, { app }) {
      const api = process.env.ARGUS_WAZZUP_API || 'https://api.wazzup24.com'; // override for tests only
      await postJson(
        `${api}/v3/message`,
        { channelId: env(app, 'WAZZUP_CHANNEL_ID'), chatId: to, chatType: 'whatsapp', text },
        { Authorization: `Bearer ${env(app, 'WAZZUP_API_KEY')}` },
      );
    },
  },
  email: {
    valid: (to) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to),
    needs: () => ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'],
    async send(to, text, { app, subject, screenshot }) {
      const { default: nodemailer } = await import('nodemailer');
      const port = Number(env(app, 'SMTP_PORT') || 587);
      const transport = nodemailer.createTransport({
        host: env(app, 'SMTP_HOST'),
        port,
        secure: port === 465, // 465 = implicit TLS; 587/25 upgrade with STARTTLS
        auth: { user: env(app, 'SMTP_USER'), pass: env(app, 'SMTP_PASSWORD') },
      });
      const info = await transport.sendMail({
        from: env(app, 'SMTP_FROM') || env(app, 'SMTP_USER'),
        to,
        subject,
        text,
        attachments: screenshot ? [{ filename: basename(screenshot), path: screenshot }] : [],
      });
      return `message id ${info.messageId}${screenshot ? ', screenshot attached' : ''}`;
    },
  },
  telegram: {
    valid: (to) => /^(-?\d+|@\w{5,})$/.test(to),
    needs: () => ['TELEGRAM_BOT_TOKEN'],
    async send(to, text, { app, screenshot }) {
      const api = process.env.ARGUS_TELEGRAM_API || 'https://api.telegram.org'; // override for tests only
      const bot = `${api}/bot${env(app, 'TELEGRAM_BOT_TOKEN')}`;
      await postJson(`${bot}/sendMessage`, { chat_id: to, text });
      if (!screenshot) return '';
      try {
        const form = new FormData();
        form.set('chat_id', to);
        form.set('caption', 'Screenshot at the moment of failure');
        form.set('photo', new Blob([readFileSync(screenshot)], { type: 'image/jpeg' }), basename(screenshot));
        const res = await fetch(`${bot}/sendPhoto`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return 'screenshot attached';
      } catch (err) {
        return `screenshot NOT attached: ${err.message}`;
      }
    },
  },
  slack: webhookChannel('slack', (text) => ({ text })),
  googlechat: webhookChannel('googlechat', (text) => ({ text })),
  // Teams "Workflows" incoming webhooks take an Adaptive Card message.
  teams: webhookChannel('teams', (text) => ({
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [{ type: 'TextBlock', text, wrap: true }],
      },
    }],
  })),
  webhook: webhookChannel('webhook', (text, { app, subject }) => ({
    source: 'argus',
    app: app || 'ALTOMATEHR',
    subject,
    text,
    sentAt: new Date().toISOString(),
  })),
};

function webhookChannel(ch, payload) {
  return {
    valid: (name) => /^[a-z0-9_-]*$/i.test(name),
    needs: (name) => [hookKey(ch, name)],
    async send(name, text, ctx) {
      await postJson(env(ctx.app, hookKey(ch, name)), payload(text, ctx));
    },
  };
}

// Parses the destination list for an app and checks each channel has what it
// needs. Returns { source, targets: [{ channel, to, ok }], problems: [string] }.
export function resolveTargets(app) {
  const own = app ? process.env[`${app}_NOTIFY`] || '' : '';
  const list = own.trim()
    ? own
    : (process.env.BITRIX_DIALOG_ID || '').split(',').filter((s) => s.trim()).map((d) => `bitrix:${d.trim()}`).join(',');
  const source = own.trim() ? `${app}_NOTIFY` : 'default (BITRIX_DIALOG_ID)';
  const targets = [];
  const problems = [];
  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = raw.indexOf(':');
    const channel = (i < 0 ? raw : raw.slice(0, i)).toLowerCase();
    const def = CHANNELS[channel];
    if (!def) {
      problems.push(`${raw}: unknown channel "${channel}" (use ${Object.keys(CHANNELS).join(', ')})`);
      continue;
    }
    const value = i < 0 ? '' : raw.slice(i + 1).trim();
    const to = def.norm ? def.norm(value) : value;
    if (!def.valid(to)) {
      problems.push(`${raw}: "${value}" isn't a valid ${channel} destination`);
      continue;
    }
    const missing = def.needs(to).filter((k) => !env(app, k).trim());
    if (missing.length) problems.push(`${raw}: missing ${missing.join(', ')}${app ? ` (or ${app}_-prefixed)` : ''} in .env`);
    targets.push({ channel, to, ok: !missing.length });
  }
  if (!targets.length && !problems.length) problems.push(`no destinations: set ${app ? `${app}_NOTIFY` : 'BITRIX_DIALOG_ID'}`);
  return { source, targets, problems };
}

const suppressed = () => /^(1|true|yes)$/i.test(process.env.ARGUS_NO_NOTIFY || '');
const STATE_FILE = join(LOGS_DIR, 'state', `${CHECK_NAME}.json`);

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(state) {
  try {
    mkdirSync(join(LOGS_DIR, 'state'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[report] could not save check state: ${err.message}`);
  }
}

export async function sendReportOnFailure(result, text, { app } = {}) {
  const attempt = Number(process.env.ARGUS_ATTEMPT || 1);
  const attempts = Number(process.env.ARGUS_ATTEMPTS || 1);
  const prev = suppressed() ? null : readState();
  const now = nowMYT();

  if (result?.error) {
    process.exitCode = 1;
    if (result.screenshot) text += `\n\n📸 Screenshot: logs/screenshots/${basename(result.screenshot)} on the Argus server`;
    if (attempt < attempts) {
      console.log('\n----- REPORT -----\n' + text + '\n------------------');
      console.log(`[report] failed on attempt ${attempt} of ${attempts} — no alert yet; run.sh will retry`);
      return;
    }
    if (attempts > 1) text += `\n🔁 Failed at ${process.env.ARGUS_FIRST_FAILED_AT || 'the first try'} and again on the retry.`;
    const stillFailing = prev?.status === 'fail';
    const failedRuns = (stillFailing ? prev.failedRuns : 0) + 1;
    if (stillFailing) text += `\n⏳ Failing since ${prev.since} (${failedRuns} failed runs in a row).`;
    console.log('\n----- REPORT -----\n' + text + '\n------------------');
    const today = now.slice(0, 10); // dd/mm/yyyy
    const alertedToday = stillFailing && prev.lastAlert === today;
    if (alertedToday) {
      console.log(`[report] still failing — already alerted today, so no repeat alert (next one tomorrow if it's still broken)`);
    } else {
      await sendReport(text, { app, screenshot: result.screenshot });
    }
    if (!suppressed()) {
      writeState({ status: 'fail', since: stillFailing ? prev.since : now, failedRuns, lastAlert: today, lastRun: now });
    }
    return;
  }

  console.log('\n----- REPORT -----\n' + text + '\n------------------');
  console.log('[report] all checks passed — logged only, no notification sent');
  if (prev?.status === 'fail') {
    const title = text.split('\n')[0].replace(/^\W*Argus\s*—\s*/u, '').replace(/\s*Report$/, '');
    const runs = `${prev.failedRuns} failed run${prev.failedRuns === 1 ? '' : 's'}`;
    await sendReport(
      [`✅ Argus — ${title} recovered`, `📅 ${now} (MYT)`, '', `Passing again after failing since ${prev.since} (${runs}).`].join('\n'),
      { app, subject: `[Argus] RECOVERED — ${title}` },
    );
  }
  if (!suppressed()) writeState({ status: 'pass', since: prev?.status === 'pass' ? prev.since : now, lastRun: now });
}

// Sends `text` to every destination of `app`; one failing channel doesn't stop the rest.
export async function sendReport(text, { app, subject, screenshot } = {}) {
  if (suppressed()) {
    console.log('[report] ARGUS_NO_NOTIFY set — notifications suppressed');
    return;
  }
  const { targets, problems } = resolveTargets(app);
  for (const p of problems) console.error(`[report] ${p}`);
  const subj = subject || `[Argus] FAILED — ${text.split('\n')[0].replace(/^\W+/u, '')}`;
  for (const { channel, to, ok } of targets) {
    if (!ok) continue;
    const label = to ? `${channel}:${to}` : channel;
    try {
      const info = await CHANNELS[channel].send(to, text, { app, subject: subj, screenshot });
      console.log(`[report] sent to ${label}${info ? ` (${info})` : ''}`);
    } catch (err) {
      console.error(`[report] failed for ${label}: ${err.message}`);
    }
  }
}
