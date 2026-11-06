import { chromium } from 'playwright';

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

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
