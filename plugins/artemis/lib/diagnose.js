// Turns the artemis/nginx probe results into "OK" or a list of problems, each with
// the likely cause and what to do. Pure function, so every outage shape can be tested.
//
// facts = {
//   site:   { status, server, ms } | { error }   GET https://hr.altomate.io/
//   app:    { status } | { error }               GET /api/auth/refresh (the app answers 405)
//   direct: { status, server } | { error }       nginx on artemis's private IP
//   ssh:    { open, error? }                     artemis's SSH port (connect only)
//   cert:   { days, validTo, authorized, reason } | { error } | { skipped }
// }
export const CERT_MIN_DAYS = 14;

const answered = (p) => p && typeof p.status === 'number';
const what = (p) => (answered(p) ? `HTTP ${p.status}` : p?.error || 'no answer');

export function diagnose(f) {
  const siteOk = f.site?.status === 200;
  const appOk = answered(f.app) && f.app.status < 500;
  const directOk = answered(f.direct) && f.direct.status < 500 && /nginx/i.test(f.direct.server || '');
  const problems = [];

  if (!directOk && !f.ssh?.open) {
    problems.push({
      short: 'artemis unreachable',
      text: 'artemis isn\'t answering at all: nginx and the SSH port are both unreachable over the ' +
        `private network (nginx: ${what(f.direct)}; SSH: ${f.ssh?.error || 'closed'}). The droplet may be ` +
        'down or rebooting. Check it in the DigitalOcean console.',
    });
  } else if (!directOk) {
    problems.push({
      short: 'nginx down on artemis',
      text: `nginx on artemis isn't answering (${what(f.direct)}), but the droplet is up (SSH port open). ` +
        'nginx is probably stopped, or failed to start after a config change or update. ' +
        'On artemis: sudo nginx -t, then sudo systemctl status nginx.',
    });
  } else if (!siteOk) {
    problems.push({
      short: `public site ${what(f.site)}`,
      text: `nginx answers on artemis's private address, but the public site fails (${what(f.site)}). ` +
        'Likely DNS, the firewall, the public IP, or the HTTPS setup (certificate or port 443).',
    });
  }

  if (siteOk && !appOk) {
    problems.push({
      short: `app behind nginx ${what(f.app)}`,
      text: `nginx and the site are up, but the AltomateHR app behind nginx isn't answering ` +
        `(/api/auth/refresh gave ${what(f.app)}; it normally gives HTTP 405). The backend service is down, ` +
        'or nginx points to the wrong place after a config change.',
    });
  }

  if (typeof f.cert?.days === 'number' && (!f.cert.authorized || f.cert.days < CERT_MIN_DAYS)) {
    problems.push(f.cert.authorized
      ? {
          short: `certificate expires in ${f.cert.days} days`,
          text: `The HTTPS certificate expires in ${f.cert.days} days (${f.cert.validTo}). Let's Encrypt ` +
            'renewal may be failing. On artemis: sudo certbot renew --dry-run.',
        }
      : {
          short: 'certificate not trusted',
          text: `The HTTPS certificate isn't trusted (${f.cert.reason || 'unknown reason'}).`,
        });
  }

  return { ok: problems.length === 0, problems };
}
