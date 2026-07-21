---
status: proposed
date: 2026-07-01
supersedes: ADR-0038
---

# Run the DOM recorder in the extension's isolated world, triggered from the chrome layer

## Context and Problem Statement

ADR-0038 shipped the DOM-mirror recorder in the page's **MAIN world**: the service worker injected rrweb via `chrome.scripting.executeScript({world:'MAIN'})`, and the recorder handed batches to the isolated content script over `window.postMessage`. Recording was gated by a `?agentdesk_record=1` URL param. All three of these are observable by the recorded page's own JS/URL: it can read `location.search`, listen for the `window.postMessage` batches (and read the entire captured DOM), and see `window.rrweb` / `window.__agentdeskDomMirrorStarted` plus rrweb's prototype patches. The requirement is that a recorded page cannot tell it is being recorded from the page layer. This decision supersedes **only** ADR-0038's recorder-injection mechanism; ADR-0038's dedicated `.dom` QUIC lane, host `DomEventLaneServer`, and client `DomMirrorSurface` are unchanged.

## Decision Drivers

- Page undetectability: no page-readable URL signal, no page-window traffic, no page-visible globals or prototype patches.
- Preserve the wire envelope, source-side password masking (ADR-0041), the native bridge (ADR-0039), and trusted input (ADR-0040) exactly.
- Testability: the trigger must be drivable by the Playwright harness, which cannot click a toolbar button.

## Considered Options

- **Option A**: Record in the extension's isolated content-script world; ship batches via `chrome.runtime.sendMessage`; trigger start/stop from a toolbar `action` + `command` hotkey.
- **Option B**: Keep the MAIN-world recorder but obfuscate the `window.postMessage` channel (random per-load name).
- **Option C**: Capture DOM via `chrome.debugger` CDP snapshots instead of rrweb.

## Decision Outcome

Chose **Option A** because the undetectability driver eliminates B and C. B still leaks: a page can enumerate its own `window` listeners, observe rrweb's prototype patches, and monkeypatch `postMessage` before our script runs — any MAIN↔isolated channel rides the shared page window and is observable in principle. C shows the `chrome.debugger` banner continuously and reworks the capture format ADR-0038 pinned. In the isolated world, rrweb's top-level `var rrweb` binding (loaded as the prior file in the same `content_scripts` entry) lives in the isolated realm, records the shared `document`, and ships batches straight to the worker over `chrome.runtime.sendMessage` — the page sees nothing. Content scripts are exempt from page CSP in the isolated world too, so the CSP-exemption rationale ADR-0038 gave for MAIN world does not actually require it. Start/stop is owned by the chrome layer: clicking the toolbar `action` opens a status popup (`popup.html`, showing whether the active tab is mirrored) with a start/stop toggle, and an `Alt+Shift+M` `command` toggles the active tab directly. Both route through shared worker functions (`startTabRecording`/`stopTabRecording`/`toggleTabRecording`) that the Playwright harness invokes via `sw.evaluate`. The `?agentdesk_record=1` gate, the MAIN-world injection, `web_accessible_resources`, and the `scripting` permission are removed.

### Consequences

- Good, because the page cannot detect recording via its own JS or URL: no `window.rrweb`, no `window.__agentdeskDomMirrorStarted`, no `window.postMessage` batches, no readable web-accessible resource path; the `scripting` permission is dropped.
- Good, because password masking, the wire envelope, the native bridge (ADR-0039), and trusted input (ADR-0040) are untouched.
- Good, because recording is now dark-by-default: it starts only on a deliberate toolbar/hotkey action, never silently on arbitrary sites.
- Bad, because isolated-world rrweb cannot patch the page realm's prototypes, so **dynamic/closed shadow DOM, canvas/WebGL pixels, and adopted/constructable stylesheets created by page script are not captured** in v1. This is strictly narrower than ADR-0041's already-deferred canvas/cross-origin gaps; static shadow roots and initial stylesheets still serialize. A v2 could add a minimal MAIN-world shim that forwards only shadow-root/adopted-sheet handles (kept off the batch-ship path) — named here, not built.
- Neutral, because MV3 service-worker eviction drops the in-memory `recordingTabId`, briefly breaking ADR-0040 tap dispatch until the next start; an active session keeps the native port (and thus the worker) alive, so this is acceptable for v1. Persist to `chrome.storage.session` if it proves flaky.

### Confirmation

`dom-mirror-record-verify` adds an invisibility assertion alongside the existing content/password checks: after recording, the page context has no `window.rrweb`, no `window.__agentdeskDomMirrorStarted`, and a page-installed `message` listener received zero `agentdesk` batches. All three verify recipes (`record`, `input`, `e2e`) trigger recording via `sw.evaluate(startTabRecording)` with no URL param; `bridge-verify` is hermetic. The absence of the `scripting` permission and `web_accessible_resources` is verifiable by inspecting `manifest.json`.

## Pros and Cons of the Options

### Option A (isolated world + chrome-layer trigger)

- Good, because the recorder is entirely invisible to the page (no URL, no window traffic, no globals).
- Good, because it drops a permission (`scripting`) and a fingerprint (web-accessible resources).
- Bad, because shadow DOM / canvas / adopted stylesheets created by page script are not captured.

### Option B (MAIN world, obfuscated channel)

- Good, because it retains full rrweb fidelity (shadow/canvas/adopted sheets).
- Bad, because it is not actually hidden: the page can observe rrweb globals/patches and intercept the shared-window channel.

### Option C (chrome.debugger CDP capture)

- Good, because it is fully in the extension layer and can capture more than isolated rrweb.
- Bad, because the debugger banner is always visible and it discards the rrweb capture/replay format ADR-0038 pinned.

## Links

- ADR-0038 (superseded: MAIN-world recorder mechanism; its `.dom` QUIC lane decision remains in force)
- ADR-0039 (native-messaging bridge, unchanged)
- ADR-0040 (trusted Chrome input, unchanged)
- ADR-0041 (projection-data audit; extend its "not representable" list with the isolated-world shadow/canvas/adopted-sheet limit)
- rrweb 2.0.0-alpha.4
