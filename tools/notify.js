// Argus alert destinations for one app: list them, or send a test alert to all.
//
//   node --env-file=/root/argus/.env tools/notify.js --app <app> --check
//       Lists <APP>_NOTIFY's destinations and what's missing. Exit 1 on any problem.
//   node --env-file=/root/argus/.env tools/notify.js --app <app> --test
//       Sends a clearly-labelled test message to every destination.
// <app> is the plugin folder name (my-app) or its env prefix (MY_APP). Omit --app
// for the default destination the AltomateHR scripts use. Never prints secrets.
import { resolveTargets, sendReport } from '../core/report.js';
import { nowMYT } from '../core/time.js';

const args = process.argv.slice(2);
const appArg = args.includes('--app') ? args[args.indexOf('--app') + 1] : '';
const mode = args.includes('--test') ? 'test' : args.includes('--check') ? 'check' : null;
if (!mode || (args.includes('--app') && !/^[A-Za-z0-9_-]+$/.test(appArg || ''))) {
  console.error('usage: notify.js [--app <app>] --check | --test');
  process.exit(2);
}
const app = appArg ? appArg.toUpperCase().replace(/-/g, '_') : undefined;

const { source, targets, problems } = resolveTargets(app);
console.log(`destinations for ${app ?? 'the default (AltomateHR)'}, from ${source}:`);
for (const t of targets) console.log(`  ${t.ok ? '✓' : '✗'} ${t.channel}${t.to ? `:${t.to}` : ''}`);
for (const p of problems) console.log(`  problem: ${p}`);

if (mode === 'test') {
  await sendReport(
    [
      `🧪 Argus test alert${app ? ` for ${app}` : ''} — please ignore.`,
      `📅 ${nowMYT()} (MYT)`,
      `If you can read this, Argus failure alerts reach this destination.`,
    ].join('\n'),
    { app, subject: `[Argus] test alert${app ? ` for ${app}` : ''} — please ignore` },
  );
}
process.exitCode = problems.length || !targets.length ? 1 : 0;
