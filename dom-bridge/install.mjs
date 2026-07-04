// Installs (or removes) the native-messaging host manifest that lets our Chrome extension spawn
// the dom-bridge shim. ADR-0039: the manifest search dir depends on the browser build. A real
// end-user Google Chrome reads a per-CHANNEL Application Support dir (see CHANNEL_DIRS). Chrome for
// Testing (what the autonomous harness drives, because stable Chrome 137+ disabled --load-extension)
// reads `<user-data-dir>/NativeMessagingHosts/` instead -- so the harness passes `--nmdir <that dir>`
// and the manifest lives entirely inside the throwaway profile, touching no real Chrome config.
//
// Usage:
//   node install.mjs --ext-id <id> [--channel chrome|canary|chromium] [--nmdir <dir>]
//                    [--socket <path>] [--token <path>] [--wrapper <path>]
//   node install.mjs --remove [--channel chrome|canary|chromium] [--nmdir <dir>] [--wrapper <path>]
//
// `--nmdir` overrides the channel preset. `--socket`/`--token`, when given, are baked into the
// wrapper's env so the shim never falls back to its hardcoded default path. `--wrapper <path>`
// overrides where the wrapper executable is written (default `dom-bridge/dom-bridge`, the path a real
// install uses); the autonomous harness points this at a throwaway temp path so a test run never
// touches a live install's wrapper. It writes a tiny wrapper executable (the manifest `path`; the
// browser spawns it with a minimal PATH, so it uses an absolute node + absolute bridge.mjs) and
// renders the manifest template.

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
// `--nmdir <dir>` targets a native-messaging dir directly, overriding the channel preset. Used by
// the autonomous harness, which drives Chrome for Testing: that build reads NM manifests from
// `<user-data-dir>/NativeMessagingHosts/` (empirically confirmed), so the manifest lives entirely
// inside the throwaway profile and touches no real Chrome config. Channel presets remain for
// installing against a real end-user Chrome.
const nmdirOverride = arg('--nmdir', null);
const nmhDir = nmdirOverride || CHANNEL_DIRS[channel];
if (!nmhDir) {
  console.error(`install: unknown --channel '${channel}' (expected chrome|canary|chromium) and no --nmdir`);
  process.exit(1);
}
const manifestPath = join(nmhDir, `${HOST_NAME}.json`);
// `--wrapper <path>` overrides the default repo wrapper. The harness passes a throwaway temp path so
// a test run writes and cleans its own wrapper and never removes a live install's `dom-bridge/dom-bridge`.
const wrapperPath = arg('--wrapper', null) || join(__dirname, 'dom-bridge');

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

// Wrapper: absolute node + absolute bridge.mjs (Chrome spawns this with a minimal PATH). When the
// caller passes explicit --socket/--token, bake them into the wrapper env so the shim never falls
// back to its hardcoded Application Support default (which would break if the host's support dir
// goes bundle-id-derived). Tests use this to point the shim at a temp socket for isolation.
const socket = arg('--socket', null);
const token = arg('--token', null);
const bridgePath = join(__dirname, 'bridge.mjs');
let envLines = '';
if (socket) envLines += `export AGENTDESK_DOM_BRIDGE_SOCKET=${JSON.stringify(socket)}\n`;
if (token) envLines += `export AGENTDESK_DOM_BRIDGE_TOKEN=${JSON.stringify(token)}\n`;
mkdirSync(dirname(wrapperPath), { recursive: true });
writeFileSync(wrapperPath, `#!/bin/sh\n${envLines}exec "${process.execPath}" "${bridgePath}"\n`);
chmodSync(wrapperPath, 0o755);

const manifest = readFileSync(join(__dirname, 'manifest.template.json'), 'utf8')
  .replace('__WRAPPER_PATH__', wrapperPath)
  .replace('__EXTENSION_ID__', extId);

mkdirSync(nmhDir, { recursive: true });
writeFileSync(manifestPath, manifest);
console.log(`install: wrote ${manifestPath}`);
console.log(`install: wrapper ${wrapperPath} -> ${process.execPath} ${bridgePath}`);
console.log(`install: allowed_origins = chrome-extension://${extId}/`);
