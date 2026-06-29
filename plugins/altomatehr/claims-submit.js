import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReport } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { navCheck, submitDummyClaim, newMarker } from './lib/claims-actions.js';

// Argus claims — SUBMIT half of the split smoke test (cron ~09:30 weekdays).
// Runs the read-only nav check, then submits ONE dummy PERSONAL expense claim
// (no receipt) and LEAVES it in place. The companion claims-cleanup.js run
// (~17:30) deletes it. The claim is never approved, so it stays SUBMITTED/
// PENDING and never touches payroll/Xero.

const ACTION = 'Claims · Submit';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;
const base = (URL || '').replace(/\/$/, '');
const MARKER = newMarker(nowMYT);

let browser, page;
const result = { login: null, nav: null, create: null, error: null };

try {
  ({ browser, page } = await launchBrowser());

  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  result.nav = await navCheck(page, base);
  if (!result.nav.success) throw new Error(result.nav.error);
  console.log('[claims-submit] nav OK');

  result.create = await submitDummyClaim(page, base, MARKER);
  if (!result.create.success) throw new Error(result.create.error);
  console.log(`[claims-submit] created "${MARKER}" (status ${result.create.status}) — left for cleanup run`);
} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[claims-submit] run failed: ${err.message}`);
} finally {
  await closeBrowser(browser);
  await sendReport(buildReport(result));
}

function buildReport(r) {
  const ts = nowMYT();
  const loginStatus = r.login?.success ? 'SUCCESS' : 'FAILED';
  const navStatus = !r.login?.success
    ? 'SKIPPED (login failed)'
    : r.nav?.success
      ? 'SUCCESS — claims page + wizard render'
      : `⚠️ FAILED — ${r.nav?.error ?? 'unknown'}`;
  const createStatus = !r.nav?.success
    ? 'SKIPPED'
    : r.create?.success
      ? `SUCCESS — "${MARKER}" (${r.create.status}); cleanup run will delete it`
      : `⚠️ FAILED — ${r.create?.error ?? 'unknown'}`;

  return [
    `🤖 Argus — ${ACTION} Report`,
    `📅 ${ts} (MYT)`,
    `👤 Account: ${EMAIL}`,
    ``,
    `🔐 Login: ${loginStatus} (${r.login?.attemptsUsed ?? '?'} attempt(s))`,
    ``,
    `🧭 Page + wizard: ${navStatus}`,
    `📝 Submit claim: ${createStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].filter((line) => line !== undefined).join('\n');
}
