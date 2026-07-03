// ADR-0047 client-gesture autonomous gate (`just dom-mirror-scroll-gesture-verify`): exercises the
// REAL index.html touch state machine (threshold deadzone, rAF-coalesced scroll posting, tap-vs-scroll
// suppression, multi-touch deactivation) in a browser -- the half that scroll-verify.mjs (worker/CDP
// side) and the Swift wire-shape unit tests do NOT cover, and exactly where the sub-threshold-jitter
// bug lived.
//
// It loads the shipping DomMirrorWebview/index.html, stubs window.webkit.messageHandlers.domMirror so
// posted messages are captured instead of thrown away, delivers ONE CDP keyframe batch to create a
// mappable surface (cdpFrame) without needing a hand-built rrweb event stream, then dispatches
// synthetic TouchEvents and asserts:
//   - a sub-threshold "tap with jitter" posts NO scroll and DOES post a tap (jitter never nudges the
//     live host page);
//   - an over-threshold drag posts a scroll and SUPPRESSES the trailing synthetic tap;
//   - a second finger (pinch) deactivates the gesture (no scroll).

import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const WEBVIEW_DIR = join(REPO, 'client', 'AgentDeskClient', 'DomMirrorWebview');

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const failures = [];
const check = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} - ${m}`); if (!c) failures.push(m); };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = join(WEBVIEW_DIR, rel);
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('not found'); }
});

// A CDP keyframe batch (ADR-0044 Tier B) the webview inflates and renders into cdpFrame. That is the
// simplest way to give index.html a mappable surface without constructing a valid rrweb event stream.
// enc 'deflate-b64' means zlib-wrapped deflate + base64, which fflate.unzlibSync decodes; node's
// zlib.deflateSync produces exactly that framing.
function cdpBatch(w, h) {
  const html = '<!doctype html><html><body style="margin:0"><div style="height:' + h + 'px">cdp</div></body></html>';
  const ev = zlib.deflateSync(Buffer.from(html, 'utf8')).toString('base64');
  return JSON.stringify({ t: 'dom-batch', tb: 1, co: true, k: 'cdp', enc: 'deflate-b64', w, h, ev });
}

let ctx = null;
async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  ctx = await chromium.launchPersistentContext('', { headless: true, viewport: { width: 800, height: 800 } });
  const page = await ctx.newPage();
  // Capture native-bound messages BEFORE any page script runs (the shim is normally injected by Swift).
  await page.addInitScript(() => {
    window.__msgs = [];
    window.webkit = { messageHandlers: { domMirror: { postMessage: (m) => window.__msgs.push(m) },
      domLog: { postMessage: () => {} } } };
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });

  // Give index.html a surface via a CDP keyframe (page 800x2000), then wait for cdpFrame to exist.
  await page.evaluate((b) => window.__domMirrorDeliver(b), cdpBatch(800, 2000));
  await page.waitForFunction(() => !!document.getElementById('cdp-frame'), { timeout: 3000 });

  // Dispatch a full touch gesture (start -> N moves -> end), then optionally a synthetic click, and
  // return the messages posted DURING that gesture. Each move is one TouchEvent stepping toward
  // (x0+dx*, y0+dy*); the webview's touchend flushes synchronously, so reads are deterministic.
  async function gesture({ x0, y0, dx, dy, steps, click, secondFinger }) {
    return await page.evaluate((g) => {
      const el = document.getElementById('tap-overlay');
      window.__msgs = [];
      const mk = (x, y, id) => new Touch({ identifier: id || 1, target: el, clientX: x, clientY: y });
      const fire = (type, touches) => el.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches.length ? touches : [mk(g.x0, g.y0)] }));
      const start = [mk(g.x0, g.y0)];
      if (g.secondFinger) start.push(mk(g.x0 + 20, g.y0 + 20, 2));
      fire('touchstart', start);
      for (let i = 1; i <= g.steps; i++) {
        const x = g.x0 + (g.dx * i) / g.steps, y = g.y0 + (g.dy * i) / g.steps;
        const t = [mk(x, y)];
        if (g.secondFinger) t.push(mk(x + 20, y + 20, 2));
        fire('touchmove', t);
      }
      fire('touchend', []);
      if (g.click) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: g.x0 + g.dx, clientY: g.y0 + g.dy }));
      return window.__msgs.filter((m) => m && (m.kind === 'scroll' || m.kind === 'tap'));
    }, { x0, y0, dx, dy, steps, click, secondFinger });
  }

  // 1. Tap with a few px of sub-threshold jitter: no scroll reaches the wire, tap still fires.
  const tap = await gesture({ x0: 200, y0: 300, dx: 3, dy: 3, steps: 3, click: true });
  check(!tap.some((m) => m.kind === 'scroll'), 'sub-threshold jitter posts NO scroll (tap does not nudge the host page)');
  check(tap.some((m) => m.kind === 'tap'), 'sub-threshold gesture still fires the tap');

  // 2. Clear over-threshold vertical drag: a scroll is posted, and the trailing click is suppressed.
  const drag = await gesture({ x0: 200, y0: 500, dx: 0, dy: -160, steps: 8, click: true });
  const scrolls = drag.filter((m) => m.kind === 'scroll');
  check(scrolls.length > 0, 'over-threshold drag posts a scroll');
  check(!drag.some((m) => m.kind === 'tap'), 'over-threshold drag suppresses the trailing synthetic tap');
  const totalDy = scrolls.reduce((s, m) => s + m.dy, 0);
  check(totalDy < -50, `scroll dy carries the finger delta direction (sum dy = ${totalDy.toFixed(0)})`);

  // 3. Two-finger gesture (pinch, Phase 2): the single-finger scroll deactivates, no scroll posted.
  const pinch = await gesture({ x0: 200, y0: 500, dx: 0, dy: -160, steps: 8, click: false, secondFinger: true });
  check(!pinch.some((m) => m.kind === 'scroll'), 'multi-touch (pinch) does not drive a host scroll');
}

async function teardown() { try { if (ctx) await ctx.close(); } catch {} try { server.close(); } catch {} }

const watchdog = setTimeout(() => { console.error('dom-mirror-scroll-gesture-verify: TIMEOUT'); teardown().finally(() => process.exit(2)); }, 60000);
watchdog.unref();

main().then(async () => {
  await teardown(); clearTimeout(watchdog);
  if (failures.length) { console.error(`\ndom-mirror-scroll-gesture-verify: ${failures.length} FAILED`); process.exit(1); }
  console.log('\ndom-mirror-scroll-gesture-verify: all checks passed');
  process.exit(0);
}).catch(async (e) => { console.error('dom-mirror-scroll-gesture-verify: ERROR', e); await teardown(); process.exit(3); });
