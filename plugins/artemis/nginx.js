// Argus artemis/nginx — is AltomateHR's web server (nginx on the artemis droplet) up?
// No login and no browser: a few plain requests, every 5 minutes.
//   1. public site       GET https://hr.altomate.io/ -> 200 from nginx
//   2. app behind nginx  GET /api/auth/refresh -> the app's own 405; 502/503/504 means
//                        nginx is up but the AltomateHR backend isn't
//   3. nginx direct      GET http://10.104.0.2/ (Host: hr.altomate.io) over the private
//                        network -> nginx's 301; tells "nginx down" apart from DNS/network
//   4. droplet           TCP connect to artemis's SSH port (connect only, never logs in)
//   5. certificate       HTTPS certificate valid for at least 14 more days
// A failed probe is re-checked after 30 s before anything is reported. Passing runs
// log one line.
//
// argus:no-browser
// argus:no-retry — it re-checks itself after 30 s; run.sh's 5-minute retry would run
// into the next 5-minute run.
import 'dotenv/config';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { sendReportOnFailure } from '../../core/report.js';
import { nowMYT } from '../../core/time.js';
import { diagnose } from './lib/diagnose.js';

const ACTION = 'Artemis nginx';
const SITE_HOST = 'hr.altomate.io';
// ARGUS_TEST_* overrides exist only for testing against local servers.
const SITE = process.env.ARGUS_TEST_SITE || `https://${SITE_HOST}`;
const PRIVATE_IP = process.env.ARGUS_TEST_PRIVATE_IP || '10.104.0.2';
const DIRECT_PORT = Number(process.env.ARGUS_TEST_DIRECT_PORT || 80);
const SSH_PORT = Number(process.env.ARGUS_TEST_SSH_PORT || 22);
const CONFIRM_MS = Number(process.env.ARGUS_TEST_CONFIRM_MS || 30_000);
const TIMEOUT_MS = 10_000;

const errText = (err) =>
  err?.name === 'TimeoutError' || err?.code === 'TIMEOUT'
    ? `no answer within ${TIMEOUT_MS / 1000} s`
    : (err?.cause?.code || err?.code || err?.cause?.message || err?.message || 'error').toString();

async function probeSite(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(SITE + path, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    return { status: res.status, server: res.headers.get('server') || '', ms: Date.now() - t0 };
  } catch (err) {
    return { error: errText(err) };
  }
}

function probeDirect() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: PRIVATE_IP, port: DIRECT_PORT, path: '/', headers: { Host: SITE_HOST }, timeout: TIMEOUT_MS },
      (res) => { res.resume(); resolve({ status: res.statusCode, server: res.headers.server || '' }); },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (err) => resolve({ error: errText(err) }));
    req.end();
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: PRIVATE_IP, port, timeout: 5000 });
    sock.on('connect', () => { sock.destroy(); resolve({ open: true }); });
    sock.on('timeout', () => { sock.destroy(); resolve({ open: false, error: 'no answer within 5 s' }); });
    sock.on('error', (err) => resolve({ open: false, error: err.code || err.message }));
  });
}

function probeCert() {
  const url = new URL(SITE);
  if (url.protocol !== 'https:') return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const sock = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: TIMEOUT_MS, rejectUnauthorized: false });
    sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const validTo = new Date(cert.valid_to);
      resolve({
        days: Math.floor((validTo - Date.now()) / 86400_000),
        validTo: validTo.toISOString().slice(0, 10),
        authorized: sock.authorized,
        reason: sock.authorizationError || '',
      });
      sock.destroy();
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'no answer within 10 s' }); });
    sock.on('error', (err) => resolve({ error: err.code || err.message }));
  });
}

async function probeAll() {
  const [site, app, direct, ssh, cert] = await Promise.all([
    probeSite('/'), probeSite('/api/auth/refresh'), probeDirect(), probePort(SSH_PORT), probeCert(),
  ]);
  return { site, app, direct, ssh, cert };
}

const show = (p) => ('status' in p ? `${p.status}${p.server ? ` (${p.server})` : ''}${p.ms != null ? `, ${(p.ms / 1000).toFixed(2)} s` : ''}` : `✗ ${p.error}`);
const certLine = (c) => (c.skipped ? 'not checked' : c.error ? `✗ ${c.error}` : `${c.authorized ? 'valid' : 'NOT trusted'}, ${c.days} days left (until ${c.validTo})`);

let facts = await probeAll();
let verdict = diagnose(facts);
if (!verdict.ok) {
  console.log(`[nginx] ${nowMYT()} problem: ${verdict.problems.map((p) => p.short).join('; ')} — re-checking in ${CONFIRM_MS / 1000} s`);
  await new Promise((r) => setTimeout(r, CONFIRM_MS));
  facts = await probeAll();
  verdict = diagnose(facts);
}

if (verdict.ok) {
  console.log(`[nginx] ${nowMYT()} OK — site ${facts.site.status} ${(facts.site.ms / 1000).toFixed(2)} s · app ${facts.app.status} · direct ${facts.direct.status} · ssh open · cert ${facts.cert.days ?? '-'} d`);
}

const result = { error: verdict.ok ? null : verdict.problems.map((p) => p.short).join('; ') };
const report = [
  `🤖 Argus — ${ACTION} Report`,
  `📅 ${nowMYT()} (MYT)`,
  '',
  ...(verdict.ok ? [] : [...verdict.problems.map((p) => `🔴 ${p.text}`), `(Still failing after a re-check ${CONFIRM_MS / 1000} s later.)`, '']),
  `🌐 Public site ${SITE}/: ${show(facts.site)}`,
  `🧩 App behind nginx (/api/auth/refresh, normally 405): ${show(facts.app)}`,
  `🖥️ nginx on artemis, direct ${PRIVATE_IP}: ${show(facts.direct)}`,
  `🔌 artemis SSH port: ${facts.ssh.open ? 'open' : `✗ ${facts.ssh.error}`}`,
  `🔒 Certificate: ${certLine(facts.cert)}`,
].join('\n');

await sendReportOnFailure(result, report, { app: 'ARTEMIS', quietPass: true });
