import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReport } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';

// Argus claims smoke test for AltomateHR.
//
// Tier 1 (always): read-only navigation — load /employee/claims, assert the
//   page + the "Submit a claim" wizard render. Creates NO data.
// Tier 2 (default, skip with ARGUS_CLAIMS_READONLY=1 or arg "readonly"):
//   submit ONE minimal PERSONAL expense claim with NO receipt upload, verify
//   it lands in the list, then DELETE it via the employee row action and
//   verify it's gone. The claim is never approved, so it stays SUBMITTED/
//   PENDING (deletable) and never triggers payroll/Xero — leaving zero trace.
//
// The marker title makes the claim unmistakable and lets the finally-block
// sweep clean up anything left behind if the run dies mid-way.

const ACTION = 'Claims';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;

const READ_ONLY =
  process.env.ARGUS_CLAIMS_READONLY === '1' || process.argv.includes('readonly');

// Unique, identifiable marker so we can find + clean up exactly our claim.
const STAMP = nowMYT().replace(/[/: ]/g, '').slice(0, 12); // e.g. 290620261432
const MARKER = `ARGUS SMOKE ${STAMP}`;

let browser, page;
const result = {
  login: null,
  nav: null, // tier 1
  create: null, // tier 2 submit
  cleanup: null, // tier 2 delete
  error: null,
};

// Today's date in MYT as YYYY-MM-DD for the <input type=date>.
function todayMYT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const base = (URL || '').replace(/\/$/, '');

// The claims list renders two DOM copies of every row (responsive desktop +
// mobile layouts), one hidden via CSS. Always target the VISIBLE copy, and
// detect the marker by checking visibility across all matches.
async function markerVisible() {
  const loc = page.locator(`text=${MARKER}`);
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

// Pick the first option of an open Radix <Select> by clicking its trigger.
async function pickFirstSelectOption(triggerId) {
  const trigger = page.locator(`#${triggerId}`);
  if (!(await trigger.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await trigger.click();
  const option = page.getByRole('option').first();
  await option.waitFor({ timeout: 5000 });
  await option.click();
  await page.waitForTimeout(500);
  return true;
}

// Open the claims list, optionally filtering by the search box. Returns the
// visible claim-row count for our marker.
async function gotoClaimsList() {
  await page.goto(base + '/employee/claims', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

// Delete the claim matching MARKER via the row's "Edit claim" → "Delete claim"
// → confirm flow. Returns true if a claim was deleted.
async function deleteMarkerClaim() {
  await gotoClaimsList();
  // Filter the list down to our marker so only our row is present.
  const search = page.getByPlaceholder(/Search by claim, title, or account/i);
  if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
    await search.fill(MARKER);
    await page.waitForTimeout(1500);
  }
  const editBtn = page.locator('button[aria-label="Edit claim"]:visible').first();
  if (!(await editBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
    return false; // nothing to delete
  }
  await editBtn.click();
  await page.waitForTimeout(1500);
  // First "Delete claim" reveals the confirm row; second submits.
  const delReveal = page.locator('[role=dialog] button:has-text("Delete claim")').first();
  await delReveal.waitFor({ timeout: 5000 });
  await delReveal.click();
  await page.waitForTimeout(800);
  const delConfirm = page.locator('[role=dialog] button:has-text("Delete claim")').last();
  await delConfirm.click();
  await page.waitForTimeout(2500);
  return true;
}

try {
  ({ browser, page } = await launchBrowser());

  // --- Login ---
  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  // --- Tier 1: read-only navigation ---
  try {
    await gotoClaimsList();
    const heading = await page
      .getByRole('heading', { name: /my claims/i })
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);
    const fab = page.locator('button[aria-label="New claim"]');
    const fabVisible = await fab.isVisible({ timeout: 5000 }).catch(() => false);

    // Open the wizard and confirm it renders, then close (no data).
    let wizardOk = false;
    if (fabVisible) {
      await fab.click();
      await page.waitForTimeout(2500);
      wizardOk = await page
        .locator('[role=dialog]:has-text("Who paid for this?")')
        .isVisible({ timeout: 6000 })
        .catch(() => false);
      // Close the dialog.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
    }

    const ok = heading && fabVisible && wizardOk;
    result.nav = {
      success: ok,
      heading,
      fab: fabVisible,
      wizard: wizardOk,
      error: ok ? null : 'one or more claims UI elements failed to render',
    };
    if (!ok) throw new Error(result.nav.error);
    console.log('[claims] tier1 nav OK');
  } catch (err) {
    if (!result.nav) result.nav = { success: false, error: err.message };
    throw err;
  }

  if (READ_ONLY) {
    console.log('[claims] READ_ONLY mode — skipping create/delete');
  } else {
    // --- Tier 2: create then self-delete ---
    try {
      // Open wizard fresh.
      await gotoClaimsList();
      await page.locator('button[aria-label="New claim"]').click();
      await page.waitForTimeout(2000);

      // Step 1: payment source — My own money (PERSONAL).
      await page.locator('[role=dialog] button:has-text("My own money")').click();
      await page.waitForTimeout(1200);
      // Step 2: claim type — Expense.
      await page.locator('[role=dialog] button:has-text("Expense claim")').click();
      await page.waitForTimeout(1200);
      // Step 3: receipt — skip (no upload → no file, no Xero Files entry).
      await page
        .getByRole('button', { name: /Skip.*fill manually/i })
        .click();
      await page.waitForTimeout(1500);

      // Step 4: the form. Fill the minimum required fields.
      await page.locator('#title').fill(MARKER);
      // Project select (only present if the employee has project assignments).
      await pickFirstSelectOption('projectId');
      // Chart of account select (required).
      const gotAccount = await pickFirstSelectOption('chartOfAccountId');
      if (!gotAccount) {
        throw new Error('No selectable chart of account available — cannot submit a claim');
      }
      await page.locator('#amount').fill('1.00');
      await page.locator('#spentAt').fill(todayMYT());
      await page
        .locator('#description')
        .fill('Argus automated smoke test — auto-deleted immediately. Do not action.');

      // Submit.
      const submitBtn = page.locator('[role=dialog] button:has-text("Submit claim")');
      await submitBtn.waitFor({ timeout: 5000 });
      await submitBtn.click();

      // Wait for the dialog to close (success) or an error to surface.
      await page
        .locator('[role=dialog]')
        .waitFor({ state: 'hidden', timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(2000);

      // Verify it appears in the list (filter by marker).
      await gotoClaimsList();
      const search = page.getByPlaceholder(/Search by claim, title, or account/i);
      if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
        await search.fill(MARKER);
        await page.waitForTimeout(1500);
      }
      const appeared = await markerVisible();
      // Read the status badge from the claim's own row (uppercase only, so we
      // don't false-match the title-case filter tabs "Pending/Approved/...").
      let status = 'unknown';
      if (appeared) {
        const editBtn = page.locator('button[aria-label="Edit claim"]:visible').first();
        const rowText = await editBtn
          .locator('xpath=ancestor::*[self::li or self::article or self::tr or self::div][2]')
          .innerText()
          .catch(() => '');
        const m = rowText.match(/\b(SUBMITTED|PENDING|APPROVED|REVIEWED|REJECTED)\b/);
        if (m) status = m[1];
      }

      result.create = {
        success: appeared,
        status,
        error: appeared ? null : 'submitted claim did not appear in the list',
      };
      if (!appeared) throw new Error(result.create.error);
      console.log(`[claims] tier2 create OK (status ${status})`);
    } catch (err) {
      if (!result.create) result.create = { success: false, error: err.message };
      throw err;
    }

    // --- Tier 2 cleanup: delete the claim we just created ---
    try {
      const deleted = await deleteMarkerClaim();
      // Verify it's gone.
      await gotoClaimsList();
      const search = page.getByPlaceholder(/Search by claim, title, or account/i);
      if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
        await search.fill(MARKER);
        await page.waitForTimeout(1500);
      }
      const stillThere = await markerVisible();
      result.cleanup = {
        success: deleted && !stillThere,
        deleted,
        gone: !stillThere,
        error: deleted && !stillThere ? null : 'claim may not have been fully deleted',
      };
      if (result.cleanup.success) console.log('[claims] tier2 cleanup OK — claim deleted');
    } catch (err) {
      if (!result.cleanup) result.cleanup = { success: false, error: err.message };
      throw err;
    }
  }
} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[claims] run failed: ${err.message}`);
} finally {
  // Safety net: if we created a claim but didn't confirm cleanup, try once more
  // so we never leave smoke-test data behind on prod.
  if (!READ_ONLY && result.create?.success && !result.cleanup?.success && page) {
    try {
      console.log('[claims] safety sweep — attempting to delete leftover marker claim');
      const swept = await deleteMarkerClaim();
      result.cleanup = {
        success: swept,
        sweep: true,
        error: swept ? null : 'safety sweep could not delete the claim — MANUAL CLEANUP NEEDED',
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
  const loginAttempts = r.login?.attemptsUsed ?? '?';

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
    READ_ONLY ? `🔎 Mode: READ-ONLY` : `🔎 Mode: create + self-delete`,
    ``,
    `🔐 Login: ${loginStatus} (${loginAttempts} attempt${loginAttempts === 1 ? '' : 's'})`,
    ``,
    `🧭 Page + wizard: ${navStatus}`,
    `📝 Create claim: ${createStatus}`,
    `🧹 Cleanup: ${cleanupStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}
