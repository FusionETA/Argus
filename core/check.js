// Identity of the running check, from its script path:
// plugins/<app>/<action>.js -> "<app>-<action>" (names screenshots and state files).
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

const script = process.argv[1] || 'run';
export const CHECK_NAME = `${basename(dirname(script))}-${basename(script, '.js')}`.replace(/[^a-z0-9-]/gi, '_');
