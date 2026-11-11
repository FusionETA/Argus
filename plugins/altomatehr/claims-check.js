import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReportOnFailure } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { navCheck } from './lib/claims-actions.js';

// Argus claims — READ-ONLY smoke test. Standalone/manual run; the weekday 09:00
// cron runs the same check inside clockin.js, right after clocking in.
// Logs in, opens the claims list and walks the "Submit a claim" wizard up to
// the form, then cancels. Nothing is submitted: since the Nov 2026 redesign
// claims are auto-approved on submit and can't be deleted by the employee,
// so the old submit + cleanup pair (claims-submit.js / claims-cleanup.js)
// was retired.

const ACTION = 'Claims · Check';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;
const base = (URL || '').replace(/\/$/, '');

let browser, page;
const result = { login: null, nav: null, error: null };

try {
  ({ browser, page } = await launchBrowser());

  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  result.nav = await navCheck(page, base);
  if (!result.nav.success) throw new Error(result.nav.error);
  console.log(`[claims-check] OK — ${result.nav.steps.length} steps passed`);
} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[claims-check] run failed: ${err.message}`);
} finally {
  await closeBrowser(browser);
  await sendReportOnFailure(result, buildReport(result));
}

function buildReport(r) {
  const ts = nowMYT();
  const loginStatus = r.login?.success ? 'SUCCESS' : 'FAILED';
  const navStatus = !r.login?.success
    ? 'SKIPPED (login failed)'
    : r.nav?.success
      ? `SUCCESS — list + wizard up to the form render (${r.nav.steps.length} steps, nothing submitted)`
      : `⚠️ FAILED — ${r.nav?.error ?? 'unknown'}`;

  return [
    `🤖 Argus — ${ACTION} Report`,
    `📅 ${ts} (MYT)`,
    `👤 Account: ${EMAIL}`,
    ``,
    `🔐 Login: ${loginStatus} (${r.login?.attemptsUsed ?? '?'} attempt(s))`,
    ``,
    `🧭 Claims page + wizard: ${navStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].filter((line) => line !== undefined).join('\n');
}
