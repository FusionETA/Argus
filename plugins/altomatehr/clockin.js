import 'dotenv/config';
import { launchBrowser, closeBrowser } from '../../core/browser.js';
import { login } from './lib/login.js';
import { sendReport } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';

const ACTION = 'Clock In';
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

  // Clock in flow
  try {
    const tapClockInBtn = page.locator('button:has-text("Tap to Clock In")');
    const clockOutBtn = page.locator('button:has-text("Clock Out")');

    // Race: find either "Tap to Clock In" or "Clock Out" (already clocked in)
    const found = await Promise.race([
      tapClockInBtn.waitFor({ timeout: 15000 }).then(() => 'clockin'),
      clockOutBtn.waitFor({ timeout: 15000 }).then(() => 'clockout'),
    ]).catch(() => 'timeout');

    if (found === 'clockout') {
      result.clock = { success: false, error: 'Already clocked in — Clock Out button is visible instead' };
      throw new Error('Already clocked in');
    } else if (found === 'timeout') {
      result.clock = { success: false, error: 'Clock In button not found on page' };
      throw new Error('Clock In button not found');
    }

    // Select default project if the dropdown is present
    const projectDropdown = page.locator('button:has-text("Select a project")');
    if (await projectDropdown.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[clockin] selecting project...');
      await projectDropdown.click();
      await page.waitForTimeout(1000);
      // Pick the first option (default project)
      const firstOption = page.locator('[role=option]').first();
      await firstOption.waitFor({ timeout: 5000 });
      await firstOption.click();
      await page.waitForTimeout(1000);
      console.log('[clockin] project selected');
    }

    await tapClockInBtn.click();

    // Capture the clock time shown on screen
    const timeEl = page.getByText(/\d{1,2}:\d{2}/).first();
    const clockTime = await timeEl.textContent({ timeout: 5000 }).catch(() => null);
    result.clock = { success: true, time: clockTime };
    console.log(`[clockin] clocked in at ${clockTime}`);
  } catch (err) {
    if (!result.clock) result.clock = { success: false, error: err.message };
    throw err;
  }

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

} catch (err) {
  if (!result.error) result.error = err.message;
  console.error(`[clockin] run failed: ${err.message}`);
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
