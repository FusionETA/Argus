import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReport } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { navCheck, submitDummyClaim, sweepClaims, newMarker } from './lib/claims-actions.js';

// Argus claims smoke test — manual all-in-one (the scheduled crons use the
// split claims-submit.js + claims-cleanup.js instead).
//
// Default: nav check, then submit ONE dummy PERSONAL expense claim (no receipt)
// and immediately self-delete it — leaving zero trace.
//   arg "readonly" (or ARGUS_CLAIMS_READONLY=1): nav check only, no data.
//   arg "nocleanup" (or ARGUS_CLAIMS_NO_CLEANUP=1): submit but LEAVE the claim
//     for manual inspection (delete it yourself afterwards).

const ACTION = 'Claims';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;
const base = (URL || '').replace(/\/$/, '');

const READ_ONLY =
  process.env.ARGUS_CLAIMS_READONLY === '1' || process.argv.includes('readonly');
const NO_CLEANUP =
  process.env.ARGUS_CLAIMS_NO_CLEANUP === '1' || process.argv.includes('nocleanup');

const MARKER = newMarker(nowMYT);

let browser, page;
const result = { login: null, nav: null, create: null, cleanup: null, error: null };

try {
  ({ browser, page } = await launchBrowser());

  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  result.nav = await navCheck(page, base);
  if (!result.nav.success) throw new Error(result.nav.error);
  console.log('[claims] nav OK');

  if (READ_ONLY) {
    console.log('[claims] READ_ONLY — skipping create/delete');
  } else {
    result.create = await submitDummyClaim(page, base, MARKER);
    if (!result.create.success) throw new Error(result.create.error);
    console.log(`[claims] create OK (status ${result.create.status})`);

    if (NO_CLEANUP) {
      result.cleanup = { success: false, skipped: true };
      console.log(`[claims] NO_CLEANUP — leaving "${MARKER}" for manual review`);
    } else {
      const { deleted, remaining } = await sweepClaims(page, base, MARKER);
      result.cleanup = {
        success: deleted > 0 && remaining === 0,
        deleted,
        remaining,
        error: deleted > 0 && remaining === 0 ? null : 'claim may not have been fully deleted',
      };
      if (result.cleanup.success) console.log('[claims] cleanup OK — claim deleted');
    }
  }
} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[claims] run failed: ${err.message}`);
} finally {
  // Safety net: if we created a claim but didn't confirm cleanup, sweep once
  // more so we never leave smoke-test data behind on prod.
  if (!READ_ONLY && !NO_CLEANUP && result.create?.success && !result.cleanup?.success && page) {
    try {
      console.log('[claims] safety sweep — removing any leftover smoke claim');
      const { deleted, remaining } = await sweepClaims(page, base, MARKER);
      result.cleanup = {
        success: remaining === 0,
        sweep: true,
        deleted,
        remaining,
        error: remaining === 0 ? null : 'safety sweep left claims behind — MANUAL CLEANUP NEEDED',
      };
    } catch (e) {
      result.cleanup = {
        success: false,
        sweep: true,
        error: `safety sweep failed: ${e.message} — MANUAL CLEANUP NEEDED`,
      };
    }
  }
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

  let createStatus;
  let cleanupStatus;
  if (READ_ONLY) {
    createStatus = 'SKIPPED (read-only mode)';
    cleanupStatus = 'SKIPPED (read-only mode)';
  } else if (!r.nav?.success) {
    createStatus = 'SKIPPED (nav failed)';
    cleanupStatus = 'SKIPPED (nav failed)';
  } else {
    createStatus = r.create?.success
      ? `SUCCESS — claim created (${r.create.status})`
      : `⚠️ FAILED — ${r.create?.error ?? 'unknown'}`;
    if (!r.create?.success) {
      cleanupStatus = 'SKIPPED (nothing created)';
    } else if (r.cleanup?.skipped) {
      cleanupStatus = `⚠️ LEFT FOR REVIEW — search "${MARKER}" then delete manually`;
    } else if (r.cleanup?.success) {
      cleanupStatus = r.cleanup.sweep
        ? '✅ deleted (via safety sweep)'
        : 'SUCCESS — claim deleted, list clean';
    } else {
      cleanupStatus = `🚨 ${r.cleanup?.error ?? 'CLEANUP FAILED — MANUAL CLEANUP NEEDED'}`;
    }
  }

  return [
    `🤖 Argus — ${ACTION} Report`,
    `📅 ${ts} (MYT)`,
    `👤 Account: ${EMAIL}`,
    READ_ONLY
      ? `🔎 Mode: READ-ONLY`
      : NO_CLEANUP
        ? `🔎 Mode: create + LEAVE for review`
        : `🔎 Mode: create + self-delete`,
    ``,
    `🔐 Login: ${loginStatus} (${r.login?.attemptsUsed ?? '?'} attempt(s))`,
    ``,
    `🧭 Page + wizard: ${navStatus}`,
    `📝 Create claim: ${createStatus}`,
    `🧹 Cleanup: ${cleanupStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].filter((line) => line !== undefined).join('\n');
}
