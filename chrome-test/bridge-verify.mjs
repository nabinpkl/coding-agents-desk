// Phase 1 autonomous gate (`just dom-mirror-bridge-verify`).
//
// Hermetic test of the sacrificial shim (dom-bridge/bridge.mjs) with NO Chrome and NO Mac host:
//   - a protocol-faithful FAKE HOST (token auth + newline JSON) stands in for DomBridgeServer,
//     whose own logic is covered by the Swift DomBridgeServerTests against the same wire contract;
//   - this harness plays "Chrome", writing 4-byte-LE framed messages to the shim's stdin and
//     reading framed messages from its stdout.
// Asserts: batch round-trip (Chrome -> shim -> host), input round-trip (host -> shim -> Chrome),
// and reconnect after the shim is killed (modeling Chrome killing it).

import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM = join(__dirname, '..', 'dom-bridge', 'bridge.mjs');
const TOKEN = 'test-token-abc123';

const work = mkdtempSync(join(tmpdir(), 'dom-bridge-verify-'));
const socketPath = join(work, 'bridge.sock');
const tokenPath = join(work, 'token');
writeFileSync(tokenPath, TOKEN + '\n');

const failures = [];
function check(cond, msg) {
  if (cond) console.log(`  ok  - ${msg}`);
  else { console.error(`  FAIL - ${msg}`); failures.push(msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 4-byte-LE framing for the "Chrome" side.
function frameForShim(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Collects a stream of 4-byte-LE framed JSON objects (shim -> "Chrome").
function makeShimOutputReader(onObj) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try { onObj(JSON.parse(payload.toString('utf8'))); } catch {}
    }
  };
}

// The fake host: newline-JSON, token-authed. Records the latest connection so the test can
// assert auth/batches and push input commands back.
let conn = null;
const state = { authed: false, batches: [], connections: 0, lastAuthToken: null };
const server = net.createServer((socket) => {
  state.connections++;
  state.authed = false;
  conn = socket;
  let acc = '';
  socket.on('data', (chunk) => {
    acc += chunk.toString('utf8');
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl); acc = acc.slice(nl + 1);
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (!state.authed) {
        state.lastAuthToken = obj.token;
        state.authed = obj.t === 'auth' && obj.token === TOKEN;
      } else if (obj.t === 'dom-batch') {
        state.batches.push(obj);
      }
    }
  });
  socket.on('error', () => {});
});

function spawnShim() {
  const child = spawn('node', [SHIM], {
    env: { ...process.env, AGENTDESK_DOM_BRIDGE_SOCKET: socketPath, AGENTDESK_DOM_BRIDGE_TOKEN: tokenPath },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdout.on('data', makeShimOutputReader((obj) => { shimOutput.push(obj); }));
  return child;
}
let shimOutput = [];

async function main() {
  await new Promise((res) => server.listen(socketPath, res));

  // --- Round 1: batch + input round-trips ---
  let shim = spawnShim();
  await sleep(400); // allow connect + auth

  check(state.connections === 1, 'shim connected to host once');
  check(state.authed === true, 'shim authenticated with the shared token');
  check(state.lastAuthToken === TOKEN, 'host received the exact token');

  // ADR-0043: the real wire ships events as a compressed base64 string (enc:'deflate-b64'); the shim
  // is an opaque relay, so it must forward the string byte-for-byte regardless of shape.
  const SAMPLE_EV = 'eNqrVkpUslJQclTSUUpSsjI0MDAwMDBQ0lFKArKMgKwkIMsYyDIBAKb2Cq4=';
  shim.stdin.write(frameForShim({ t: 'dom-batch', tb: 5, co: true, enc: 'deflate-b64', ev: SAMPLE_EV }));
  await sleep(300);
  check(state.batches.length === 1, 'host received exactly one dom-batch');
  check(state.batches[0]?.tb === 5 && state.batches[0]?.co === true, 'batch tab/checkout preserved');
  check(state.batches[0]?.enc === 'deflate-b64' && state.batches[0]?.ev === SAMPLE_EV,
    'compressed base64 batch forwarded verbatim (opaque shim)');

  // Host -> shim -> "Chrome" (input command, framed back to 4-byte-LE).
  shimOutput = [];
  conn.write(JSON.stringify({ t: 'dom-input', k: 'mouse', x: 12, y: 34 }) + '\n');
  await sleep(300);
  check(shimOutput.length === 1, 'shim framed exactly one host message back to Chrome');
  check(shimOutput[0]?.t === 'dom-input' && shimOutput[0]?.x === 12 && shimOutput[0]?.y === 34, 'input command round-tripped intact');

  // --- Round 2: reconnect after the shim is killed (Chrome killing it) ---
  shim.kill('SIGKILL');
  await sleep(300);
  const shim2 = spawnShim();
  await sleep(400);
  check(state.connections === 2, 'a fresh shim reconnects to the host');
  check(state.authed === true, 'reconnected shim re-authenticates (state did not leak)');
  shim2.kill('SIGKILL');

  server.close();
  rmSync(work, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\ndom-mirror-bridge-verify: ${failures.length} FAILED`);
    process.exit(1);
  }
  console.log('\ndom-mirror-bridge-verify: all checks passed');
  process.exit(0);
}

// Global watchdog so a hang never blocks the autonomous loop.
setTimeout(() => { console.error('dom-mirror-bridge-verify: TIMEOUT'); process.exit(2); }, 15000).unref();

main().catch((e) => { console.error('dom-mirror-bridge-verify: ERROR', e); process.exit(3); });
