// Shared building blocks for the AltomateHR claims smoke test (claims-check.js).
//
// READ-ONLY by design. Since the Nov 2026 redesign a submitted claim is
// auto-approved immediately and the employee UI has no delete, so a test claim
// can't be cleaned up and would flow into the claims run / payroll. The check
// walks the "Submit a claim" wizard up to the filled-in form and cancels —
// nothing is ever submitted.

// The employee shell is a single-page app since the Nov 2026 redesign: views are
// addressed by a `?v=` query param, and the old /employee/claims route now just
// renders the Dashboard (URL unchanged) — which is what broke every claims run
// from 2026-11-09. Deep-link straight to "My claims".
export const CLAIMS_VIEW = '/?v=claims/claims-mine';

// Search box of the claims list. It renders twice (desktop + mobile copies, one
// hidden via CSS), so always scope to the visible one.
const searchBox = (page) =>
  page.getByPlaceholder(/Search by claim, title, or account/i).locator('visible=true');

// The claim wizard is a plain fixed overlay since the redesign — no
// role=dialog — so track it by its title instead.
const wizardTitle = (page) => page.getByText('Submit a claim', { exact: true });

// Waits up to `timeout` for the element. (locator.isVisible() ignores its
// timeout and checks once — too early for the form's selects, which render
// after their options load.)
const visible = (locator, timeout = 5000) =>
  locator
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

export async function gotoClaimsList(page, base) {
  await page.goto(base + CLAIMS_VIEW, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

// Read-only check of the claims page and the full "Submit a claim" wizard:
//   list (heading + search) → New claim FAB → "Who paid?" → "My own money" →
//   "Expense claim" → skip receipt → form (Title / Amount / item type options /
//   Submit button) → Cancel → wizard closed.
// Stops at the first step that fails and names it. Never clicks "Submit claim".
export async function navCheck(page, base) {
  const steps = [];
  const step = async (name, ok) => {
    steps.push(name);
    if (!ok) throw new Error(name);
  };

  try {
    await gotoClaimsList(page, base);
    await step(
      'claims heading',
      // Loose match: the title has been renamed before ("My Claims" -> "Claims").
      await visible(page.getByRole('heading', { name: /claims/i }).first(), 8000),
    );
    await step('claims list (search box)', await visible(searchBox(page)));

    const fab = page.locator('button[aria-label="New claim"]');
    await step('new-claim FAB', await visible(fab));
    await fab.click();
    await step(
      'wizard step 1 "Who paid for this?"',
      (await visible(wizardTitle(page), 6000)) &&
        (await visible(page.getByText('Who paid for this?'))),
    );

    const ownMoney = page.getByRole('button', { name: /My own money/ });
    await step('"My own money" option', await visible(ownMoney));
    await ownMoney.click();

    const expense = page.getByRole('button', { name: /Expense claim/ });
    await step('wizard step 2 "Expense claim" option', await visible(expense));
    await expense.click();

    const skip = page.getByRole('button', { name: /Skip.*fill manually/i });
    await step('wizard step 3 receipt "Skip … fill manually"', await visible(skip));
    await skip.click();

    // Form fields have no ids since the redesign but are label-associated.
    await step(
      'form fields (Title, Amount, Expense date)',
      (await visible(page.getByLabel('Title', { exact: true }))) &&
        (await visible(page.getByLabel('Amount', { exact: true }))) &&
        (await visible(page.getByLabel('Expense date', { exact: true }))),
    );

    // An employee with no claim item types can't submit anything, so check the
    // select actually offers one. Opening + Escape changes nothing.
    // Find it by its label, not its placeholder: the form pre-fills the item
    // type last used, so "Select claim item type" isn't always shown.
    // (The hidden claim-details panel also has a "Claim item type" caption, but
    // no combobox next to it.)
    const itemType = page.locator(
      'div:has(> span:text-is("Claim item type")) > button[role=combobox]',
    );
    await step('claim item type select', await visible(itemType));
    await itemType.click();
    const optionCount = await page
      .getByRole('option')
      .first()
      .waitFor({ timeout: 5000 })
      .then(() => page.getByRole('option').count())
      .catch(() => 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await step('claim item type options', optionCount > 0);

    await step(
      '"Submit claim" button',
      await visible(page.getByRole('button', { name: 'Submit claim', exact: true })),
    );

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await step(
      'wizard closes on Cancel',
      await wizardTitle(page)
        .waitFor({ state: 'hidden', timeout: 5000 })
        .then(() => true)
        .catch(() => false),
    );

    return { success: true, steps, error: null };
  } catch (err) {
    // Close the wizard if it's still open — nothing was submitted either way.
    await page.keyboard.press('Escape').catch(() => {});
    return {
      success: false,
      steps,
      error: `claims check failed at: ${err.message} (url ${page.url()})`,
    };
  }
}
