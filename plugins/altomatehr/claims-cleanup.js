import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReport } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { sweepClaims, MARKER_PREFIX } from './lib/claims-actions.js';

// Argus claims — CLEANUP half of the split smoke test (cron ~17:30 weekdays).
// Deletes EVERY leftover smoke claim (title starts with "ARGUS SMOKE"),
// regardless of which submit run created it. Anything that can't be deleted
// from the employee UI (e.g. a smoke claim that got approved/reviewed during
// the day and is no longer editable) is reported as remaining for a human.

const ACTION = 'Claims · Cleanup';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;
const base = (URL || '').replace(/\/$/, '');

let browser, page;
const result = { login: null, sweep: null, error: null };

try {
  ({ browser, page } = await launchBrowser());

  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  result.sweep = await sweepClaims(page, base, MARKER_PREFIX);
  console.log(`[claims-cleanup] deleted ${result.sweep.deleted}, remaining ${result.sweep.remaining}`);
} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[claims-cleanup] run failed: ${err.message}`);
} finally {
  await closeBrowser(browser);
  await sendReport(buildReport(result));
}

function buildReport(r) {
  const ts = nowMYT();
  const loginStatus = r.login?.success ? 'SUCCESS' : 'FAILED';

  let sweepStatus;
  if (!r.login?.success) {
    sweepStatus = 'SKIPPED (login failed)';
  } else if (!r.sweep) {
    sweepStatus = `⚠️ FAILED — ${r.error ?? 'unknown'}`;
  } else if (r.sweep.remaining > 0) {
    sweepStatus = `🚨 deleted ${r.sweep.deleted}, but ${r.sweep.remaining} smoke claim(s) REMAIN (not deletable — likely approved). MANUAL CLEANUP NEEDED`;
  } else if (r.sweep.deleted === 0) {
    sweepStatus = 'SUCCESS — no leftover smoke claims (list already clean)';
  } else {
    sweepStatus = `SUCCESS — deleted ${r.sweep.deleted} smoke claim(s), list clean`;
  }

  return [
    `🤖 Argus — ${ACTION} Report`,
    `📅 ${ts} (MYT)`,
    `👤 Account: ${EMAIL}`,
    ``,
    `🔐 Login: ${loginStatus} (${r.login?.attemptsUsed ?? '?'} attempt(s))`,
    ``,
    `🧹 Cleanup (title starts "${MARKER_PREFIX}"): ${sweepStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].filter((line) => line !== undefined).join('\n');
}
