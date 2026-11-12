// TEMPLATE for a new Argus check — copy to plugins/<app>/<action>.js and replace
// every MY_APP / my-app / "TODO" below. Mirrors plugins/altomatehr/claims-check.js.
import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { blockWrites } from '../../core/guard.js';
import { sendReportOnFailure } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { login } from './lib/login.js';

// Argus my-app — READ-ONLY smoke test: TODO one line on what it proves.
// TODO: which pages it walks and where it stops (e.g. "up to the form, then Cancel").

const ACTION = 'TODO Human Name';
const URL = process.env.MY_APP_URL;
const USER = process.env.MY_APP_EMAIL;
const PASSWORD = process.env.MY_APP_PASSWORD;
const base = (URL || '').replace(/\/$/, '');

let browser, page;
const result = { login: null, check: null, blocked: [], error: null };

try {
  ({ browser, page } = await launchBrowser());

  result.login = await login(page, base, USER, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  // Read-only from here: any POST/PUT/PATCH/DELETE is aborted and logged.
  // (Leave this out ONLY for an approved write check — see SKILL.md step 5.)
  result.blocked = await blockWrites(page);

  result.check = await runCheck(page);
  if (!result.check.success) throw new Error(result.check.error);
  console.log(`[my-app] OK — ${result.check.steps.length} steps passed`);
} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[my-app] run failed: ${err.message}`);
} finally {
  await closeBrowser(browser);
  await sendReportOnFailure(result, buildReport(result));
}

// Walks the steps in order and stops at the first that fails, naming it.
async function runCheck(page) {
  const steps = [];
  const step = async (name, ok) => {
    steps.push(name);
    if (!ok) throw new Error(name);
  };
  const visible = (locator, timeout = 8000) =>
    locator.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);

  try {
    await page.goto(base + '/TODO-path', { waitUntil: 'domcontentloaded' });
    await step('TODO page heading', await visible(page.getByRole('heading', { name: /TODO/i }).first()));
    // TODO: more steps — prefer getByRole / getByLabel / getByText over CSS classes.
    return { success: true, steps, error: null };
  } catch (err) {
    return { success: false, steps, error: `failed at: ${err.message} (url ${page.url()})` };
  }
}

function buildReport(r) {
  const loginStatus = r.login?.success ? 'SUCCESS' : 'FAILED';
  const checkStatus = !r.login?.success
    ? 'SKIPPED (login failed)'
    : r.check?.success
      ? `SUCCESS (${r.check.steps.length} steps)`
      : `⚠️ FAILED — ${r.check?.error ?? r.error ?? 'unknown'}`;

  return [
    `🤖 Argus — ${ACTION} Report`,
    `📅 ${nowMYT()} (MYT)`,
    `👤 Account: ${USER}`,
    ``,
    `🔐 Login: ${loginStatus} (${r.login?.attemptsUsed ?? '?'} attempt(s))`,
    ``,
    `🧭 Check: ${checkStatus}`,
    r.blocked.length ? `\n🛡️ Write requests blocked: ${r.blocked.length} (first: ${r.blocked[0]})` : '',
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].join('\n');
}
