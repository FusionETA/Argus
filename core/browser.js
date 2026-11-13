import { chromium } from 'playwright';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_NAME, LOGS_DIR } from './check.js';

// Failure screenshots: <repo>/logs/screenshots/<app>-<action>-<YYYYMMDD-HHMMSS>.jpg,
// kept for KEEP_DAYS days.
const SHOT_DIR = join(LOGS_DIR, 'screenshots');
const KEEP_DAYS = 30;

export async function launchBrowser() {
  const browser = await chromium.launch({ headless: false });
  // AltomateHR's attendance clock-in reads the browser geolocation; without it the
  // dashboard shows "Location unavailable" and the tap never registers. Grant a
  // location (env-overridable; defaults to Kuala Lumpur). No geofence is set on the
  // smoke account, so any valid coordinate works.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['geolocation'],
    geolocation: {
      latitude: parseFloat(process.env.ALTOMATEHR_LAT || '3.1390'),
      longitude: parseFloat(process.env.ALTOMATEHR_LNG || '101.6869'),
    },
  });
  const page = await context.newPage();
  return { browser, page };
}

// Pass the check's `result` so a failed run (result.error set) gets a screenshot of
// the last open page before the browser closes; its path lands on result.screenshot
// and core/report.js attaches it to the alert.
export async function closeBrowser(browser, result) {
  if (!browser) return;
  if (result?.error) result.screenshot = await captureFailure(browser);
  await browser.close().catch(() => {});
}

async function captureFailure(browser) {
  try {
    const page = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed()).at(-1);
    if (!page) return null;
    mkdirSync(SHOT_DIR, { recursive: true });
    pruneScreenshots();
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' }).replace(/[-: ]/g, '').replace(/^(\d{8})/, '$1-');
    const file = join(SHOT_DIR, `${CHECK_NAME}-${stamp}.jpg`);
    await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 75, timeout: 15000 });
    console.log(`[browser] failure screenshot: ${file}`);
    return file;
  } catch (err) {
    console.error(`[browser] could not take a failure screenshot: ${err.message}`);
    return null;
  }
}

function pruneScreenshots() {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  for (const f of readdirSync(SHOT_DIR)) {
    const p = join(SHOT_DIR, f);
    try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* already gone */ }
  }
}
