# rrweb DOM-mirror spike

A throwaway spike to eyeball one claim before committing to a Chrome-DOM-multiplexing
subsystem: **can we stream a page's DOM (not pixels) to a second surface, get
vector-crisp text, and pay only tiny bandwidth?**

This is deliberately *not* wired into the AgentDesk host/client. The relay stands in
for the future path (content-script → Native Messaging → Mac host → QUIC → iPhone
WKWebView). Here it's a zero-dependency Node process and two browser tabs.

## Run it (30 seconds)

```bash
cd spikes/rrweb-dom-mirror
node relay.mjs
```

Then open two tabs:

- Recorder: <http://localhost:7900/recorder>
- Viewer:   <http://localhost:7900/viewer>

The recorder streams its own DOM; the viewer re-renders it locally. Type in the
recorder's text box, scroll it, watch the log tick — the viewer follows, and every
glyph is rendered by the viewer's own browser, so it's sharp at any "network".

To record a **real** site instead of the demo page, see [bookmarklet.md](./bookmarklet.md).

## What to look for

- **Crispness.** Text in the viewer is real DOM text, not decoded tiles. Zoom in — no blur.
- **Bandwidth.** The relay console prints uncompressed `KB/s` and `ev/s` every second.
  Stop interacting and it falls toward zero (idle DOM = no deltas). Every ~5s you'll see
  a spike: that's `checkoutEveryNms` re-sending a full snapshot so a late viewer can join.
  Real transport would gzip/deflate this (~5-10x smaller for DOM), so the printed number
  is a pessimistic ceiling.
- **Late join.** Open a second viewer tab mid-session — it bootstraps to the current
  frame from the relay's buffered checkout, then goes live. That's the "phone just
  paired, catch it up" mechanic.

## What it deliberately does NOT prove

Matches the boundaries from the design discussion — reach for the pixel path here:

- **Canvas / WebGL / `<video>`** — element state syncs, pixels don't. Not covered.
- **Cross-origin iframes** — unreadable by the recorder (browser security). Come across blank.
- **Asset reachability** — the viewer loads images/fonts/CSS *by URL*. On this same-origin
  demo that's free; for a real authed app the phone can't fetch cookie-gated or
  localhost-only assets, so production needs `inlineImages`/`inlineStylesheet` (bandwidth)
  or an asset proxy through the host (which has the session). This spike sidesteps it.
- **Input round-trip** — the viewer is read-only here. Real use routes taps back to the
  live page (synthetic events, or `chrome.debugger` for `isTrusted` input).

## Files

| File | Role |
|------|------|
| `relay.mjs` | Zero-dep Node relay: POST `/emit` in, SSE `/events` out, buffers last checkout, prints bandwidth. Stands in for the host+transport. |
| `recorder-demo.html` | Self-recording rich page (text, code, table, live clock, editable box). |
| `viewer.html` | Live `rrweb.Replayer` in `liveMode`, bootstraps from the snapshot then `addEvent`s. |
| `bookmarklet.md` | Inject the recorder into any (CSP-permitting) real page. |

## Notes for productionizing (not done here)

- Pin rrweb and add Subresource Integrity (`integrity="sha384-…"`) to the script tags —
  the spike loads from jsDelivr unpinned-by-hash for convenience.
- Replace the CDN load + bookmarklet with a MV3 extension content script (dodges page CSP).
- Replace POST/SSE with Native Messaging → host → the existing QUIC transport → WKWebView.
- Turn on rrweb privacy masking (`maskAllInputs`, `.rr-mask`, `.rr-block`) before any
  real page is streamed.
