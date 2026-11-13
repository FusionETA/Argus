import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReportOnFailure } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { navCheck } from './lib/claims-actions.js';

// Argus 09:00 run — one login, then clock in followed by the read-only claims
// check (same as claims-check.js, nothing submitted) in the same browser session.
const TITLE = 'Clock In + Claims Check';
const ACTION = 'Clock In';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;
const base = (URL || '').replace(/\/$/, '');

let browser, page;
const result = { login: null, clock: null, approval: null, claims: null, error: null };

try {
  ({ browser, page } = await launchBrowser());

  // Login
  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  // Clock in flow
  try {
    // The dashboard sometimes shows a browser-notification nudge that overlays the card.
    const notNow = page.getByRole('button', { name: /not now/i });
    if (await notNow.isVisible({ timeout: 2000 }).catch(() => false)) {
      await notNow.click().catch(() => {});
      await page.waitForTimeout(500);
    }

    // The clock widget uses plain text labels (not <button>s). Off shift it reads
    // "Tap to Clock In" (first shift of the day) or "Start another shift" (after a
    // completed shift); on shift it reads "Tap to Clock Out".
    const tapClockIn = page.getByText(/Tap to Clock In|Start another shift/i).first();
    const clockOut = page.getByText('Tap to Clock Out').first();

    // Race: find either "Tap to Clock In" or "Clock Out" (already clocked in)
    const found = await Promise.race([
      tapClockIn.waitFor({ timeout: 15000 }).then(() => 'clockin'),
      clockOut.waitFor({ timeout: 15000 }).then(() => 'clockout'),
    ]).catch(() => 'timeout');

    if (found === 'clockout') {
      result.clock = { success: false, error: 'Already clocked in — Clock Out is shown instead' };
      throw new Error('Already clocked in');
    } else if (found === 'timeout') {
      result.clock = { success: false, error: 'Clock In control not found on page' };
      throw new Error('Clock In control not found');
    }

    // Select default project only if a dropdown is present (modern UI pre-selects it).
    const projectDropdown = page.locator('button:has-text("Select a project")');
    if (await projectDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[clockin] selecting project...');
      await projectDropdown.click();
      await page.waitForTimeout(1000);
      const firstOption = page.locator('[role=option]').first();
      await firstOption.waitFor({ timeout: 5000 });
      await firstOption.click();
      await page.waitForTimeout(1000);
      console.log('[clockin] project selected');
    }

    // The tappable control is the card wrapping the "Tap to Clock In" label, not the
    // <p> itself — clicking the card fires POST /api/attendance/clock-in.
    const card = tapClockIn.locator(
      'xpath=ancestor::*[contains(@class,"rounded-[24px]") or contains(@class,"cursor-pointer")][1]'
    );
    const clickTarget = (await card.count()) ? card.first() : tapClockIn;
    await clickTarget.click();

    // Confirm it registered: the widget flips to on-shift ("Tap to Clock Out" appears).
    await page.getByText('Tap to Clock Out').first().waitFor({ timeout: 10000 });
    const timeEl = page.getByText(/\d{1,2}:\d{2}/).first();
    const clockTime = await timeEl.textContent({ timeout: 5000 }).catch(() => null);
    result.clock = { success: true, time: clockTime };
    console.log(`[clockin] clocked in at ${clockTime}`);
  } catch (err) {
    // Record it but don't abort: the claims check below doesn't depend on the
    // clock widget, so it still runs.
    if (!result.clock) result.clock = { success: false, error: err.message };
    result.error = err.message;
    console.error(`[clockin] clock in failed: ${err.message}`);
  }

  if (result.clock?.success) {
    // Wait for auto-approval (~90 seconds)
    console.log('[clockin] waiting 90s for auto-approval...');
    await new Promise(resolve => setTimeout(resolve, 90_000));

    // Read approval status
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const approvalEl = page.getByText(/approved|pending|rejected/i).first();
      const approvalText = await approvalEl.textContent({ timeout: 10000 });
      result.approval = approvalText.trim();
      console.log(`[clockin] approval status: ${result.approval}`);
    } catch (err) {
      result.approval = `unknown (${err.message})`;
    }
  }

  // Claims check (read-only — walks the wizard to the form and cancels)
  result.claims = await navCheck(page, base);
  if (result.claims.success) {
    console.log(`[clockin] claims check OK — ${result.claims.steps.length} steps passed`);
  } else {
    result.error = [result.error, result.claims.error].filter(Boolean).join('; ');
    console.error(`[clockin] ${result.claims.error}`);
  }

} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[clockin] run failed: ${err.message}`);
} finally {
  await closeBrowser(browser, result);
  await sendReportOnFailure(result, buildReport(result));
}

function buildReport(r) {
  const ts = nowMYT();
  const loginStatus = r.login?.success ? 'SUCCESS' : 'FAILED';
  const loginAttempts = r.login?.attemptsUsed ?? '?';
  const loginPage = r.login?.landedOn ?? 'n/a';

  let clockStatus;
  if (!r.login?.success) {
    clockStatus = 'SKIPPED (login failed)';
  } else if (r.clock?.success) {
    clockStatus = `SUCCESS — clocked in at ${r.clock.time ?? 'unknown time'}`;
  } else {
    clockStatus = `FAILED — ${r.clock?.error ?? 'unknown error'}`;
  }

  let approvalStatus;
  if (!r.clock?.success) {
    approvalStatus = 'SKIPPED (clock action failed)';
  } else {
    const status = r.approval ?? 'unknown';
    const isApproved = /approved/i.test(status);
    approvalStatus = isApproved ? status : `⚠️ ${status}`;
  }

  const claimsStatus = !r.login?.success
    ? 'SKIPPED (login failed)'
    : r.claims?.success
      ? `SUCCESS — list + wizard up to the form render (${r.claims.steps.length} steps, nothing submitted)`
      : r.claims
        ? `⚠️ FAILED — ${r.claims.error ?? 'unknown'}`
        : 'NOT RUN (run aborted)';

  return [
    `🤖 Argus — ${TITLE} Report`,
    `📅 ${ts} (MYT)`,
    `👤 Account: ${EMAIL}`,
    ``,
    `🔐 Login: ${loginStatus} (${loginAttempts} attempt${loginAttempts === 1 ? '' : 's'})`,
    `   Page: ${loginPage}`,
    ``,
    `⏱️ ${ACTION}: ${clockStatus}`,
    ``,
    `✅ Approval: ${approvalStatus}`,
    ``,
    `🧭 Claims page + wizard: ${claimsStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].filter(line => line !== undefined).join('\n');
}
