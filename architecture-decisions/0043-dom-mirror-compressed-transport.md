---
status: proposed
date: 2026-07-01
---

# Compress DOM-mirror batches end-to-end, snapshot as a rare keyframe, chunk as a backstop

## Context and Problem Statement

Heavy pages do not mirror. The isolated-world recorder (ADR-0042) ships each rrweb batch as **raw, uncompressed JSON** and re-emits a **full snapshot every 5 s** (`checkoutEveryNms: 5000`), while the host caps a single newline-framed line from the shim at **2 MB** (`DomBridgeServer.maxLineBytes`). A real page's masked FullSnapshot exceeds 2 MB, so the host throws `frameTooLarge` on every checkout, the client never receives a snapshot, and nothing renders. This was proven from the host probe log (`/tmp/agentdesk-dom-mirror-host.log`): zero successful `checkout=true` lines and repeated framing errors on a heavy page.

The recorder must stay in the extension's **isolated content-script world** (ADR-0042): the fix cannot reach into the page's MAIN world. It is purely a transport-and-cadence change; the recording surface, masking (ADR-0041), native bridge (ADR-0039), trusted input (ADR-0040), and the `.dom` QUIC lane (ADR-0038) are untouched.

The chain between the recorder and the phone is already an **opaque relay**: the shim, `DomBridgeServer`, `DomMirrorRelay`, the `.dom` lane, and the Swift `DomMirrorClient`/`DomMirrorSurface` parse only `{t, tb, co}` and forward the rest of the line verbatim. So a payload can be transformed at the source (extension service worker) and reversed at the sink (replay webview) with nothing in between changed.

## Decision Drivers

- A heavy real page must mirror: every wire line must stay well under the 2 MB frame cap.
- No MAIN-world injection (ADR-0042 constraint held).
- Keep the host and Swift client opaque -- no per-format Swift work, and the host→phone bandwidth win comes for free.
- Match proven session-replay practice (rrweb, PostHog, Highlight, Datadog, LogRocket): compress off the main thread, keep tens-of-KB units, take the full snapshot as a rare keyframe, chunk only past a large threshold.
- Late-joining phones must still bootstrap quickly.

## Considered Options

- **Option A**: Compress each batch's events (deflate/zlib + base64) in the **service worker**, keep it opaque end-to-end, decompress in the **replay webview**; drop the keyframe cadence to 2 min (+ a forced snapshot on SPA navigation); chunk a still-oversized compressed batch as a bounded backstop; keep the 2 MB cap as a memory guard.
- **Option B**: Raise `maxLineBytes` to fit an uncompressed snapshot (e.g. 16 MB).
- **Option C**: LogRocket-style asset stripping + host-side CSS/asset dedup caching.
- **Option D**: Compress in the content script (isolated world) instead of the service worker.

## Decision Outcome

Chose **Option A**.

- **Compression** (`fflate.zlibSync` + base64) runs in the **service worker**, off the recorded page's main thread, so it adds zero page jank. A masked FullSnapshot that was multiple MB raw becomes tens of KB. The envelope gains `enc: 'deflate-b64'` and `ev` becomes a base64 string. The webview inflates with `fflate.unzlibSync`; the `record-verify` fake host and Node's `zlib.inflateSync` read the same zlib stream. fflate is vendored on both ends (`chrome-extension/vendor/fflate.min.js`, `client/AgentDeskClient/DomMirrorWebview/fflate.min.js`).
- **Cadence**: `checkoutEveryNms` goes 5000 → 120000 (2 min, matching Highlight's keyframe interval), plus `slimDOMOptions` to drop non-visual nodes (scripts, comments, head metadata) before serialization. Because a wall-clock keyframe does not move on SPA route changes, the isolated recorder polls `location.href` on its existing 250 ms flush tick and calls `rrweb.record.takeFullSnapshot(true)` on change -- a keyframe without a MAIN-world history hook. The 2-min keyframe both bounds the host's late-join buffer (which resets on `checkout=true`) and keeps reconnect bootstrap fast via the buffer seed.
- **Chunk backstop**: if a compressed base64 batch still exceeds ~1.5 MB (needs a >~15 MB raw snapshot), the service worker splits it into `cid/seq/total` parts, each a normal `dom-batch` line with `co` set only on part 0. The host forwards each opaquely; the webview reassembles by `cid` (keyed by `seq` against reorder/dup) and then inflates. Setting `co` only on part 0 means the host buffer resets once per snapshot, not per part, so the whole chunked snapshot stays together.
- The **2 MB cap stays** as a memory safety bound; compression + chunking keep every line under it.

Rejected: **B** trades a hard failure for unbounded memory and still ships multi-MB frames over the phone link every keyframe -- it fixes rendering but not bandwidth, and weakens the DoS bound. **C** is a much larger subsystem (asset store + URL rewriting, ADR-0041 territory) and unnecessary once batches are compressed; `inlineStylesheet` stays `true` for correct replay and compression absorbs its size. **D** would compress on the recorded page's own main thread (isolated world still shares the page thread), risking visible jank on the very heavy pages this targets; the service worker is already off-page-thread and MV3 forbids nested workers there, so the SW is the right seam.

### Consequences

- Good: heavy pages mirror; every wire line is well under 2 MB; the host→phone byte count drops ~5–10× on real pages.
- Good: host and Swift client are unchanged (opaque relay); no protocol-version bump needed (DOM mirror is experimental and flag-gated, pre-v0).
- Good: the MAIN-world constraint (ADR-0042) holds -- SPA-nav keyframes use a poll, not a page hook.
- Neutral: the extension and the client webview must agree on `deflate-b64`; they ship together (webview bundled in the client, extension loaded from this repo).
- Bad: a rare keyframe means a client that joins mid-interval waits for the buffered snapshot rather than a fresh one; the late-join buffer seed and SPA-nav keyframe keep this bounded.
- Bad: fflate is now a build dependency on both ends; a format mismatch would silently drop batches (mitigated by the `record-verify` round-trip through Node zlib).

### Confirmation

- `dom-mirror-record-verify` inflates each batch's `ev` (Node `zlib.inflateSync`) before the capture/masking assertions, so marker-present and secrets-absent are checked on the *decompressed* stream; it additionally asserts the raw wire is compressed (`enc === 'deflate-b64'`, `ev` a string, marker absent until inflated) so the round-trip is load-bearing.
- `dom-mirror-bridge-verify` sends a compressed-shape batch and asserts the shim forwards the base64 string verbatim (opaque).
- `dom-mirror-e2e` exercises the full compress → relay → inflate → render path and asserts the sim probe `dom-mirror-probe marker=dommirror-capture-ok`.
- Host `DomBridgeServerTests` / `DomMirrorRelayTests` / `DomBridgeIntegrationTests` and client `DomMirrorSurfaceTests` are unchanged: they validate the opaque `{t, tb, co}` contract, which a string `ev` does not alter.

## Links

- ADR-0038 (dedicated `.dom` QUIC lane; relayed opaquely here)
- ADR-0039 (native-messaging bridge; opaque passthrough, unchanged)
- ADR-0040 (trusted Chrome input; unchanged)
- ADR-0041 (mask audit; masking runs before compression, unchanged)
- ADR-0042 (isolated-world recorder; MAIN-world constraint held)
- fflate (zlib deflate/inflate), rrweb 2.0.0-alpha.4 (`checkoutEveryNms`, `slimDOMOptions`, `takeFullSnapshot`)

## Explicit non-goal

CSS/asset dedup + host-side caching (LogRocket-style asset store with URL rewriting) is deliberately out of scope: it is a much larger subsystem and unnecessary once batches are compressed. Named here so it is not mistaken for missing scope.
