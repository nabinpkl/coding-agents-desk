// Installs (or removes) the native-messaging host manifest that lets our Chrome extension spawn
// the dom-bridge shim. ADR-0039: Chrome reads this manifest from a per-CHANNEL support dir (NOT
// under --user-data-dir), so the throwaway test profile and the daily profile share it; the file
// is uniquely named so it never collides with anything else in that dir.
//
// Usage:
//   node install.mjs --ext-id <chrome-extension-id> [--channel chrome|canary|chromium]
//   node install.mjs --remove [--channel chrome|canary|chromium]
//
// It writes a tiny wrapper executable (so Chrome, which spawns the manifest `path` directly with a
// minimal PATH, gets an absolute node + absolute bridge.mjs) and renders the manifest template.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.example.agentdesk.agentdesk.dom_bridge';

const CHANNEL_DIRS = {
  chrome: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
  canary: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
  chromium: join(homedir(), 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const remove = process.argv.includes('--remove');
const channel = arg('--channel', 'chrome');
const nmhDir = CHANNEL_DIRS[channel];
if (!nmhDir) {
  console.error(`install: unknown --channel '${channel}' (expected chrome|canary|chromium)`);
  process.exit(1);
}
const manifestPath = join(nmhDir, `${HOST_NAME}.json`);
const wrapperPath = join(__dirname, 'dom-bridge');

if (remove) {
  for (const p of [manifestPath, wrapperPath]) {
    if (existsSync(p)) { rmSync(p); console.log(`install: removed ${p}`); }
  }
  process.exit(0);
}

const extId = arg('--ext-id', null);
if (!extId || !/^[a-p]{32}$/.test(extId)) {
  console.error('install: --ext-id <32-char chrome extension id (a-p)> is required');
  process.exit(1);
}

// Wrapper: absolute node + absolute bridge.mjs (Chrome spawns this with a minimal PATH).
const bridgePath = join(__dirname, 'bridge.mjs');
writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${bridgePath}"\n`);
chmodSync(wrapperPath, 0o755);

const manifest = readFileSync(join(__dirname, 'manifest.template.json'), 'utf8')
  .replace('__WRAPPER_PATH__', wrapperPath)
  .replace('__EXTENSION_ID__', extId);

mkdirSync(nmhDir, { recursive: true });
writeFileSync(manifestPath, manifest);
console.log(`install: wrote ${manifestPath}`);
console.log(`install: wrapper ${wrapperPath} -> ${process.execPath} ${bridgePath}`);
console.log(`install: allowed_origins = chrome-extension://${extId}/`);
