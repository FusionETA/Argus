export async function login(page, url, email, password) {
  // Navigate directly to the login form (the landing page just links here)
  const loginUrl = url.replace(/\/$/, '') + '/login';
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // If already logged in, the page redirects away from /login — log out first
  if (!page.url().includes('/login')) {
    console.log('[login] already logged in, logging out first...');
    const logoutLocator = page.locator('button:has-text("Log out"), a:has-text("Log out")');
    await logoutLocator.waitFor({ timeout: 5000 });
    await logoutLocator.click();
    await page.waitForURL(u => u.includes('/login') || u.endsWith('/'), { timeout: 10000 }).catch(() => {});
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  let attemptsUsed = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    attemptsUsed = attempt;

    try {
      // Fill credentials
      const emailField = page.getByLabel(/email/i).or(page.locator('input[type=email]')).first();
      const passwordField = page.locator('input[type=password]').first();

      await emailField.fill(email);
      await passwordField.fill(password);

      const submitBtn = page.locator('button[type=submit]:has-text("Login")').first();
      console.log(`[login] clicking submit, current URL: ${page.url()}`);
      await submitBtn.click();

      // Poll URL every second for up to 20s
      let landed = false;
      for (let s = 0; s < 20; s++) {
        await page.waitForTimeout(1000);
        const current = page.url();
        console.log(`[login] ${s + 1}s after submit: ${current}`);
        if (!current.includes('/login')) {
          landed = true;
          break;
        }
      }

      if (landed) {
        return {
          success: true,
          attemptsUsed,
          landedOn: page.url(),
          error: null,
        };
      }

      // Still on login page — grab any error message shown
      const errorEl = page.locator('.error, [class*=error], [class*=alert]').first();
      lastError = await errorEl.textContent({ timeout: 2000 }).catch(() => `Login attempt ${attempt} failed`);
      console.log(`[login] attempt ${attempt} failed: ${lastError}`);

      // Reset for next attempt — navigate back to login page
      if (attempt < 3) {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
      }
    } catch (err) {
      lastError = err.message;
      console.log(`[login] attempt ${attempt} error: ${lastError}`);
      if (attempt < 3) {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
      }
    }
  }

  return {
    success: false,
    attemptsUsed,
    landedOn: page.url(),
    error: lastError || 'Login failed after 3 attempts',
  };
}
