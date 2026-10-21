import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const stateHome = path.join(runtimeDir, 'state-home');
const browserPath = process.env.VIDEO_HYPERFRAMES_BROWSER_PATH
  || (() => { throw new Error('Set VIDEO_HYPERFRAMES_BROWSER_PATH from the generated workspace config'); })();

if (!existsSync(browserPath)) {
  throw new Error(`Configured existing browser is missing: ${browserPath}. No browser download will be attempted.`);
}

// This CLI version has no config-home option and initializes per-user metadata
// even when telemetry is disabled. Limit that state to this runtime process.
// Neither HOME nor USERPROFILE is changed; upstream package files stay intact.
os.homedir = () => stateHome;
syncBuiltinESMExports();

process.env.HYPERFRAMES_BROWSER_PATH = browserPath;
process.env.PRODUCER_HEADLESS_SHELL_PATH = browserPath;
process.env.HYPERFRAMES_NO_TELEMETRY = '1';
process.env.HYPERFRAMES_NO_UPDATE_CHECK = '1';
process.env.HYPERFRAMES_NO_AUTO_INSTALL = '1';
process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = path.join(runtimeDir, 'frames-cache');
process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';

const command = process.argv[2];
if (['init', 'skills', 'upgrade'].includes(command)
    || (command === 'browser' && process.argv[3] !== 'path')) {
  console.error('This isolated runtime does not deploy Skills, upgrade pinned dependencies, or download/remove browsers.');
  process.exitCode = 2;
} else {
  await import('./node_modules/hyperframes/bin/hyperframes.mjs');
}
