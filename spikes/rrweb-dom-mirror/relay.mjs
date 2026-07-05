// rrweb DOM-mirror spike — zero-dependency relay.
//
// Stands in for the future Native-Messaging -> Mac host -> QUIC -> iPhone path.
// Recorder POSTs batched rrweb events to /emit; viewers subscribe over SSE at
// /events. The relay keeps the most recent checkout (Meta + FullSnapshot + the
// incrementals since) so a viewer that connects late is bootstrapped to a
// coherent frame, then fed live — the same "late joiner catches up" mechanic a
// freshly-paired phone needs.
//
// It also prints uncompressed wire bytes/sec so you can eyeball the
// crisp-text-at-tiny-bandwidth claim. Real transport would gzip/deflate this
// (~5-10x smaller for DOM), so treat the printed number as a pessimistic ceiling.
//
// Run:  node relay.mjs   (PORT env overrides 7900)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 7900;

// rrweb EventType numbers we care about for checkout tracking.
const META = 4;
const FULL_SNAPSHOT = 2;

// Live viewer SSE connections.
const viewers = new Set();

// Events since (and including) the most recent checkout, replayed to late joiners.
let buffer = [];
function bufferEvent(e) {
  if (e.type === META) {
    buffer = [e]; // a checkout begins with Meta
  } else if (e.type === FULL_SNAPSHOT) {
    if (buffer.length === 0 || buffer[buffer.length - 1].type !== META) buffer = [];
    buffer.push(e);
  } else {
    buffer.push(e);
  }
  // Backstop if no checkout ever arrives (e.g. checkoutEveryNms disabled).
  if (buffer.length > 5000) buffer.splice(0, buffer.length - 5000);
}

// Rolling bandwidth stats, printed once a second.
let bytesWindow = 0;
let eventsWindow = 0;
let totalBytes = 0;
let totalEvents = 0;
setInterval(() => {
  if (eventsWindow > 0) {
    const kbps = (bytesWindow / 1024).toFixed(1);
    console.log(
      `[relay] ${kbps} KB/s  ${eventsWindow} ev/s  viewers=${viewers.size}  ` +
        `total=${(totalBytes / 1024).toFixed(0)}KB/${totalEvents}ev`
    );
  }
  bytesWindow = 0;
  eventsWindow = 0;
}, 1000);

function broadcast(eventJson) {
  const line = `data: ${eventJson}\n\n`;
  for (const res of viewers) res.write(line);
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

async function serveHtml(res, name) {
  try {
    const buf = await readFile(join(__dirname, name));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors());
    res.end();
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/recorder')) {
    serveHtml(res, 'recorder-demo.html');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/viewer') {
    serveHtml(res, 'viewer.html');
    return;
  }

  // Viewer subscribes here (Server-Sent Events).
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...cors(),
    });
    res.write(': connected\n\n');
    // Bootstrap the late joiner with the current checkout, then go live.
    for (const e of buffer) res.write(`data: ${JSON.stringify(e)}\n\n`);
    viewers.add(res);
    req.on('close', () => viewers.delete(res));
    return;
  }

  // Recorder pushes batched events here.
  if (req.method === 'POST' && url.pathname === '/emit') {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const n = Buffer.byteLength(body);
      totalBytes += n;
      bytesWindow += n;
      let events;
      try {
        events = JSON.parse(body);
      } catch {
        res.writeHead(400, cors());
        res.end('bad json');
        return;
      }
      if (!Array.isArray(events)) events = [events];
      for (const e of events) {
        totalEvents++;
        eventsWindow++;
        bufferEvent(e);
        broadcast(JSON.stringify(e));
      }
      res.writeHead(204, cors());
      res.end();
    });
    return;
  }

  res.writeHead(404, cors());
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`rrweb DOM-mirror spike relay on http://localhost:${PORT}`);
  console.log(`  recorder: http://localhost:${PORT}/recorder`);
  console.log(`  viewer:   http://localhost:${PORT}/viewer`);
});
