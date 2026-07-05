// ADR-0039 sacrificial native-messaging shim ("dom-bridge").
//
// Chrome spawns and OWNS this process (stdio pipe; killed when the extension port / tab / browser
// closes). It holds no state and only re-frames bytes between two wires:
//
//   Chrome  <-- 4-byte little-endian length-prefixed JSON (native messaging) -->  this shim
//   this shim  <-- newline-delimited JSON over a Unix domain socket -->  AgentDeskHost DomBridgeServer
//
// It is deliberately dumb so Chrome never owns the real host: a shim death is just a socket
// disconnect the host tolerates. Socket path and token come from the environment (so the test
// harness can point at a temp socket) or default to the host's Application Support location.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// This default MUST track host Config.applicationSupportDirectory (Config.swift), which is
// "AgentDesk" in this branch. If the host's support dir ever becomes bundle-id-derived (see
// AGENTS.md "Host build variants"), this default breaks silently -- so Phase 2's install wrapper
// should pass AGENTDESK_DOM_BRIDGE_SOCKET/_TOKEN explicitly (computed from the host at install
// time) and make this literal a last-resort fallback, never the load-bearing path.
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'AgentDesk');
const SOCKET_PATH = process.env.AGENTDESK_DOM_BRIDGE_SOCKET || join(APP_SUPPORT, 'ad-dom-bridge.sock');
const TOKEN_PATH = process.env.AGENTDESK_DOM_BRIDGE_TOKEN || join(APP_SUPPORT, 'ad-dom-bridge-token');

function readToken() {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

// --- Chrome stdio: 4-byte LE length-prefixed JSON ---
let inBuf = Buffer.alloc(0);
const pendingToHost = []; // Chrome messages parsed before the socket is ready
let socketReady = false;

function frameToChrome(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function handleChromeMessage(obj) {
  // Forward as one newline-delimited JSON line to the host socket.
  const line = JSON.stringify(obj) + '\n';
  if (socketReady) {
    sock.write(line);
  } else {
    pendingToHost.push(line);
  }
}

process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const payload = inBuf.subarray(4, 4 + len);
    inBuf = inBuf.subarray(4 + len);
    try {
      handleChromeMessage(JSON.parse(payload.toString('utf8')));
    } catch {
      // Drop malformed frames rather than crash the shim.
    }
  }
});
process.stdin.on('end', () => process.exit(0));

// --- Host Unix socket: newline-delimited JSON ---
const sock = net.createConnection({ path: SOCKET_PATH });
let outBuf = '';

sock.on('connect', () => {
  const token = readToken();
  // Authenticate first (ADR-0039 defence-in-depth over the 0o600 socket), then flush any
  // Chrome messages that arrived before the socket was ready.
  sock.write(JSON.stringify({ t: 'auth', v: 1, token }) + '\n');
  socketReady = true;
  for (const line of pendingToHost.splice(0)) sock.write(line);
});

sock.on('data', (chunk) => {
  outBuf += chunk.toString('utf8');
  let nl;
  while ((nl = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, nl);
    outBuf = outBuf.slice(nl + 1);
    if (!line) continue;
    try {
      frameToChrome(JSON.parse(line)); // host -> Chrome (input commands, Phase 5)
    } catch {
      // Ignore malformed host lines.
    }
  }
});

// Chrome owns our lifecycle: on any socket error/close, exit so Chrome can respawn us on the
// next connectNative. We never try to keep the host alive or reconnect on our own.
sock.on('error', () => process.exit(1));
sock.on('close', () => process.exit(0));
