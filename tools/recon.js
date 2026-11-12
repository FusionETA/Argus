// Argus recon — READ-ONLY page inventory for planning a new check.
//
// Logs in (optional), turns on the write guard, then for each URL: loads it,
// screenshots it and lists headings, buttons, links, form fields, tables and
// dialogs. It never clicks anything. Output: recon/<app>/<n>.png + inventory.json.
//
// Credentials come from env (<APP>_URL, <APP>_EMAIL or <APP>_USERNAME,
// <APP>_PASSWORD, optional <APP>_LOGIN_URL) — never from the command line.
//
// Usage (from the repo root, headed browser needs a display):
//   ARGUS_NO_NOTIFY=1 xvfb-run -a /opt/node24/bin/node --env-file=/root/argus/.env \
//     tools/recon.js --app myapp [--login] [--allow-post <regex>]... <url-or-path>...
// Paths ("/settings") are resolved against <APP>_URL.
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, closeBrowser } from '../core/browser.js';
import { blockWrites } from '../core/guard.js';

const args = process.argv.slice(2);
let app = null;
let doLogin = false;
const allow = [];
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--app') app = args[++i];
  else if (args[i] === '--login') doLogin = true;
  else if (args[i] === '--allow-post') allow.push(new RegExp(args[++i]));
  else targets.push(args[i]);
}
if (!app || !/^[a-z0-9-]+$/.test(app) || !targets.length) {
  console.error('usage: recon.js --app <app> [--login] [--allow-post <regex>]... <url-or-path>...');
  process.exit(2);
}

const P = app.toUpperCase().replace(/-/g, '_');
const base = (process.env[`${P}_URL`] || '').replace(/\/$/, '');
const user = process.env[`${P}_EMAIL`] || process.env[`${P}_USERNAME`];
const password = process.env[`${P}_PASSWORD`];
const outDir = `recon/${app}`;
mkdirSync(outDir, { recursive: true });

const resolve = (t) => (/^https?:\/\//.test(t) ? t : base + (t.startsWith('/') ? t : `/${t}`));

let browser, page;
const report = { app, startedAt: new Date().toISOString(), login: null, pages: [], blocked: [] };

try {
  ({ browser, page } = await launchBrowser());

  if (doLogin) {
    if (!user || !password) throw new Error(`${P}_EMAIL/${P}_USERNAME and ${P}_PASSWORD must be set`);
    const loginUrl = process.env[`${P}_LOGIN_URL`] || base;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    // Generic form fill: first visible email/username field + password, then Enter.
    const userField = page
      .locator('input[type=email], input[autocomplete=username], input[name*=user i], input[name*=email i], input[type=text]')
      .locator('visible=true')
      .first();
    await userField.fill(user);
    const pw = page.locator('input[type=password]').locator('visible=true').first();
    await pw.fill(password);
    await pw.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const stillOnForm = await pw.isVisible().catch(() => false);
    report.login = { url: page.url(), passwordFieldStillVisible: stillOnForm };
    console.log(`[recon] after login: ${page.url()}${stillOnForm ? '  (password field still visible — login may have failed)' : ''}`);
    await page.screenshot({ path: `${outDir}/00-after-login.png`, fullPage: true });
  }

  // From here on, nothing may write.
  report.blocked = await blockWrites(page, { allow });

  for (const [i, t] of targets.entries()) {
    const url = resolve(t);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const shot = `${outDir}/${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    const inv = await page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const txt = (el) => (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
      const labelFor = (el) =>
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText.trim()) ||
        el.getAttribute('aria-label') || el.placeholder || el.name || '';
      return {
        title: document.title,
        headings: all('h1,h2,h3,[role=heading]').map((h) => `${h.tagName.toLowerCase()}: ${txt(h)}`),
        buttons: all('button,[role=button],input[type=submit],input[type=button]').map(txt).filter(Boolean),
        links: all('a[href]').slice(0, 80).map((a) => `${txt(a) || '(no text)'} -> ${a.getAttribute('href')}`),
        fields: all('input:not([type=hidden]),select,textarea,[role=combobox]').map(
          (f) => `${f.tagName.toLowerCase()}[${f.type || f.getAttribute('role') || ''}] ${labelFor(f)}`,
        ),
        tables: all('table').map((t) => [...t.querySelectorAll('th')].map((th) => th.innerText.trim()).join(' | ')),
        dialogs: all('[role=dialog],dialog[open]').map(txt),
      };
    });
    report.pages.push({ requested: url, landed: page.url(), screenshot: shot, ...inv });
    console.log(`\n### ${url}\n  landed: ${page.url()}\n  title: ${inv.title}\n  screenshot: ${shot}`);
    for (const k of ['headings', 'buttons', 'fields', 'tables', 'dialogs', 'links']) {
      if (inv[k].length) console.log(`  ${k} (${inv[k].length}):\n    ${inv[k].slice(0, 40).join('\n    ')}`);
    }
  }
} catch (err) {
  report.error = err.message;
  console.error(`[recon] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
  writeFileSync(`${outDir}/inventory.json`, JSON.stringify(report, null, 2));
  console.log(`\n[recon] ${report.blocked.length} write request(s) blocked; inventory: ${outDir}/inventory.json`);
}
