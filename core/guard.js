// Write guard for read-only checks and investigation (recon) runs.
//
// After login, call blockWrites(page) and every request that could change data
// (POST / PUT / PATCH / DELETE) is aborted at the network layer and logged, so a
// mis-click can't save, submit or delete anything. GET / HEAD / OPTIONS pass.
//
// Some apps read through POST (GraphQL queries, search endpoints). Allow those
// one by one with `allow` (array of RegExp tested against the full URL); each
// allowed POST is still logged.
//
// Session/token refresh calls are allowed by default (AUTH_REFRESH below): SPAs
// such as AltomateHR re-authenticate with POST /api/auth/refresh on every page
// load, and blocking it logs the check out. They renew the login, not app data.
// Pass { allowAuthRefresh: false } to block them too.
//
// It's a safety net, not a guarantee: WebSocket messages and service-worker
// requests aren't covered, so a read-only check must still never click a
// save/submit/delete control.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_REFRESH = [
  /\/(auth|token|oauth|session)s?\/(refresh|renew)([/?#]|$)/i,
  /\/refresh[-_]?token([/?#]|$)/i,
];

export async function blockWrites(page, { allow = [], allowAuthRefresh = true } = {}) {
  const blocked = [];
  if (allowAuthRefresh) allow = [...AUTH_REFRESH, ...allow];
  await page.context().route('**/*', (route) => {
    const req = route.request();
    const method = req.method();
    if (SAFE_METHODS.has(method)) return route.continue();
    if (allow.some((re) => re.test(req.url()))) {
      console.log(`[guard] allowed ${method} ${req.url()}`);
      return route.continue();
    }
    blocked.push(`${method} ${req.url()}`);
    console.log(`[guard] BLOCKED ${method} ${req.url()}`);
    return route.abort('blockedbyclient');
  });
  return blocked;
}
