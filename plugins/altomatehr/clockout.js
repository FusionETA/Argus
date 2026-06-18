import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReport } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';

const ACTION = 'Clock Out';
const URL = process.env.ALTOMATEHR_URL;
const EMAIL = process.env.ALTOMATEHR_EMAIL;
const PASSWORD = process.env.ALTOMATEHR_PASSWORD;

let browser, page;
const result = { login: null, clock: null, approval: null, error: null };

try {
  ({ browser, page } = await launchBrowser());

  // Login
  result.login = await login(page, URL, EMAIL, PASSWORD);
  if (!result.login.success) {
    result.error = result.login.error;
    throw new Error('Login failed');
  }

  // Navigate to attendance / clock area and clock out
  try {
    const clockOutBtn = page.locator('button:has-text("Clock Out")');
    const clockInBtn = page.locator('button:has-text("Clock In")');

    // Race: find either Clock Out or Clock In button
    const found = await Promise.race([
      clockOutBtn.waitFor({ timeout: 15000 }).then(() => 'clockout'),
      clockInBtn.waitFor({ timeout: 15000 }).then(() => 'clockin'),
    ]).catch(() => 'timeout');

    if (found === 'clockin') {
      result.clock = { success: false, error: 'Employee is not clocked in' };
      throw new Error('Employee is not clocked in');
    } else if (found === 'timeout') {
      result.clock = { success: false, error: 'Clock Out button not found on page' };
      throw new Error('Clock Out button not found');
    }

    await clockOutBtn.click();

    // Handle confirmation modal
    const confirmBtn = page.locator('button:has-text("Confirm clock out")');
    await confirmBtn.waitFor({ timeout: 10000 });
    await confirmBtn.click();
    console.log('[clockout] confirmed clock out');

    // Capture the clock time shown on screen
    const timeEl = page.getByText(/\d{1,2}:\d{2}/).first();
    const clockTime = await timeEl.textContent({ timeout: 5000 }).catch(() => null);
    result.clock = { success: true, time: clockTime };
    console.log(`[clockout] clocked out at ${clockTime}`);
  } catch (err) {
    if (!result.clock) result.clock = { success: false, error: err.message };
    throw err;
  }

  // Wait for auto-approval (~90 seconds)
  console.log('[clockout] waiting 90s for auto-approval...');
  await new Promise(resolve => setTimeout(resolve, 90_000));

  // Read approval status
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const approvalEl = page.getByText(/approved|pending|rejected/i).first();
    const approvalText = await approvalEl.textContent({ timeout: 10000 });
    result.approval = approvalText.trim();
    console.log(`[clockout] approval status: ${result.approval}`);
  } catch (err) {
    result.approval = `unknown (${err.message})`;
  }

} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[clockout] run failed: ${err.message}`);
} finally {
  await closeBrowser(browser);
  await sendReport(buildReport(result));
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
    clockStatus = `SUCCESS — clocked out at ${r.clock.time ?? 'unknown time'}`;
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

  return [
    `🤖 Argus — ${ACTION} Report`,
    `📅 ${ts} (MYT)`,
    `👤 Account: ${EMAIL}`,
    ``,
    `🔐 Login: ${loginStatus} (${loginAttempts} attempt${loginAttempts === 1 ? '' : 's'})`,
    `   Page: ${loginPage}`,
    ``,
    `⏱️ ${ACTION}: ${clockStatus}`,
    ``,
    `✅ Approval: ${approvalStatus}`,
    r.error ? `\n❌ Error: ${r.error}` : '',
  ].filter(line => line !== undefined).join('\n');
}
