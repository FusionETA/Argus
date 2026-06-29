// Shared building blocks for the AltomateHR claims smoke tests.
//
// Used by claims.js (manual create+self-delete), claims-submit.js (cron: create
// + leave) and claims-cleanup.js (cron: delete every leftover smoke claim).
//
// All smoke claims carry a title starting with MARKER_PREFIX so they can be
// found and swept regardless of which run created them.

export const MARKER_PREFIX = 'ARGUS SMOKE';

// A unique, identifiable claim title, e.g. "ARGUS SMOKE 290620261432".
export function newMarker(nowMYT) {
  const stamp = nowMYT().replace(/[/: ]/g, '').slice(0, 12);
  return `${MARKER_PREFIX} ${stamp}`;
}

// Today's date in MYT as YYYY-MM-DD for the <input type=date>.
export function todayMYT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function gotoClaimsList(page, base) {
  await page.goto(base + '/employee/claims', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

// Filter the list via the search box. Returns true if the box was present.
export async function searchClaims(page, text) {
  const search = page.getByPlaceholder(/Search by claim, title, or account/i);
  if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
    await search.fill(text);
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

// The "Showing N of M claims" counter (N = currently shown). null if not found.
export async function shownCount(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const m = body.match(/Showing\s+(\d+)\s+of\s+(\d+)\s+claims/i);
  return m ? Number(m[1]) : null;
}

// The claims list renders two DOM copies of every row (responsive desktop +
// mobile), one hidden via CSS. Check visibility across all matches.
export async function textVisible(page, text) {
  const loc = page.locator(`text=${text}`);
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

// Pick the first option of a Radix <Select> by clicking its trigger id.
export async function pickFirstSelectOption(page, triggerId) {
  const trigger = page.locator(`#${triggerId}`);
  if (!(await trigger.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await trigger.click();
  const option = page.getByRole('option').first();
  await option.waitFor({ timeout: 5000 });
  await option.click();
  await page.waitForTimeout(500);
  return true;
}

// Read-only Tier 1 check: claims page heading + "New claim" FAB + the wizard
// dialog all render. Opens and closes the wizard (no data written).
export async function navCheck(page, base) {
  await gotoClaimsList(page, base);
  const heading = await page
    .getByRole('heading', { name: /my claims/i })
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);
  const fab = page.locator('button[aria-label="New claim"]');
  const fabVisible = await fab.isVisible({ timeout: 5000 }).catch(() => false);

  let wizardOk = false;
  if (fabVisible) {
    await fab.click();
    await page.waitForTimeout(2500);
    wizardOk = await page
      .locator('[role=dialog]:has-text("Who paid for this?")')
      .isVisible({ timeout: 6000 })
      .catch(() => false);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
  }

  const success = heading && fabVisible && wizardOk;
  return {
    success,
    heading,
    fab: fabVisible,
    wizard: wizardOk,
    error: success ? null : 'one or more claims UI elements failed to render',
  };
}

// Submit ONE minimal PERSONAL expense claim with NO receipt upload, titled
// `marker`. Verifies it appears in the list. Returns { success, status, error }.
// Does NOT delete it — callers decide cleanup.
export async function submitDummyClaim(page, base, marker) {
  await gotoClaimsList(page, base);
  await page.locator('button[aria-label="New claim"]').click();
  await page.waitForTimeout(2000);

  // Step 1: payment source — My own money (PERSONAL).
  await page.locator('[role=dialog] button:has-text("My own money")').click();
  await page.waitForTimeout(1200);
  // Step 2: claim type — Expense.
  await page.locator('[role=dialog] button:has-text("Expense claim")').click();
  await page.waitForTimeout(1200);
  // Step 3: receipt — skip (no upload → no file, no Xero Files entry).
  await page.getByRole('button', { name: /Skip.*fill manually/i }).click();
  await page.waitForTimeout(1500);

  // Step 4: the form. Fill the minimum required fields.
  await page.locator('#title').fill(marker);
  await pickFirstSelectOption(page, 'projectId'); // only if employee has projects
  const gotAccount = await pickFirstSelectOption(page, 'chartOfAccountId');
  if (!gotAccount) {
    return {
      success: false,
      status: null,
      error: 'No selectable chart of account available — cannot submit a claim',
    };
  }
  await page.locator('#amount').fill('1.00');
  await page.locator('#spentAt').fill(todayMYT());
  await page
    .locator('#description')
    .fill('Argus automated smoke test — safe to ignore. Auto-deleted by Argus cleanup run.');

  const submitBtn = page.locator('[role=dialog] button:has-text("Submit claim")');
  await submitBtn.waitFor({ timeout: 5000 });
  await submitBtn.click();

  // Wait for the dialog to close (success) or an error to surface.
  await page.locator('[role=dialog]').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Verify it appears (filter by marker).
  await gotoClaimsList(page, base);
  await searchClaims(page, marker);
  const appeared = await textVisible(page, marker);

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

  return {
    success: appeared,
    status,
    error: appeared ? null : 'submitted claim did not appear in the list',
  };
}

// Delete every claim whose title matches `query` (default: all smoke claims)
// via the employee row "Edit → Delete claim → confirm" flow. Only SUBMITTED/
// PENDING claims expose the delete UI — anything left over (e.g. an approved
// smoke claim) is reported as `remaining`. Returns { deleted, remaining }.
export async function sweepClaims(page, base, query = MARKER_PREFIX) {
  await gotoClaimsList(page, base);
  await searchClaims(page, query);

  let deleted = 0;
  let guard = 0;
  while (guard < 25) {
    guard++;
    const editBtn = page.locator('button[aria-label="Edit claim"]:visible').first();
    if (!(await editBtn.isVisible({ timeout: 3000 }).catch(() => false))) break;
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
    deleted++;
    await gotoClaimsList(page, base);
    await searchClaims(page, query);
  }

  // Anything still matching the filter couldn't be deleted from the employee UI
  // (most likely it was approved/reviewed and is no longer in an editable state).
  const remaining = (await shownCount(page)) ?? 0;
  return { deleted, remaining };
}
