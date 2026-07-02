---
status: proposed
date: 2026-07-02
---

# DOM-mirror capture pause/resume driven by client surface visibility

## Context and Problem Statement

The Chrome DOM mirror is now a selectable third surface in the iOS client's
switcher (Control | Agent | Browser). When the user is on Control or Agent, the
Browser surface is not visible, yet the whole capture pipeline keeps running:
the extension's rrweb recorder keeps serializing DOM mutations, the host keeps
framing and pushing batches over the `.dom` lane, and the client keeps replaying
them into a hidden WKWebView. That is wasted CPU on every layer (the earlier
profiling arc made host/extension CPU a first-class concern), spent rendering a
surface no one is looking at.

We want to pause capture at the source when Browser is not in view and resume it
cleanly when it returns, without a partial hack that desyncs the replay.

## Decision Drivers

- **Real CPU win at the source.** rrweb recording (and any CDP polling) is the
  expensive part; a client-only "stop reading the lane" would leave the
  extension recording and the host pushing into an unread stream (QUIC
  backpressure), saving only the client's replay cost.
- **Clean resume, no desync.** rrweb is stateful: dropping mutation events
  mid-stream and resuming shows a stale/broken DOM until the next full snapshot.
  Resume must re-establish a full snapshot.
- **Reuse existing rails.** The `.dom` lane already carries a client->host
  reverse channel (ADR-0040 taps), and the extension already has
  `agentdesk-start` / `agentdesk-stop` recorder controls. Prefer composition
  over new machinery.
- **Backward compatible.** An old host or old extension that does not understand
  the new frame must degrade to "capture keeps running", not break.

## Decision

Add one client->host control frame on the `.dom` lane,
`{ "t": "dom-capture", "on": <bool> }` (`DomCaptureCommand`), sent when the
client's active surface changes: `on: false` when Browser leaves view, `on: true`
when it enters. It rides the same path as ADR-0040 taps:

1. **Client** (`DomMirrorClient.setCapture(_:)`) sends the frame up the `.dom`
   lane, guarded on the lane having been started (so it never races the role
   announce the host reads first). The switcher calls it from
   `surfaceSegmentChanged` (`setCapture(surface == .browser)`).
2. **Host** (`DomEventLaneServer`) forwards recognized control frames verbatim to
   the bridge. The receive guard was generalized from "decode as
   `DomInputCommand`" to `isForwardableDomControl(_:)`, which whitelists `t ∈
   {dom-input, dom-capture}` and drops everything else (echoed batches,
   malformed lines).
3. **Extension** (`worker.js`) maps `dom-capture` to `setCapturePaused(paused)`,
   which stops/starts the rrweb recorder on the **already-recording** tab while
   keeping `recordingTabId` (unlike `stopTabRecording`, which ends the session).
   Pausing stops `rrweb.record()` and shows a `PAUSE` badge; resuming restarts
   it. Because `rrweb.record()` emits a full snapshot on start, resume repaints
   the mirror cleanly with no mid-stream desync — the clean-resume requirement
   is satisfied for free.

Capture is only ever paused/resumed, never started, by the phone: if nothing is
recording (`recordingTabId == null`) the command is a no-op. Starting capture
stays user-initiated via the popup. `capturePaused` is reset to `false` on every
`startTabRecording` / `stopTabRecording` so it cannot leak across sessions.

## Consequences

- Real CPU is reclaimed at the source (recorder + host push + client replay)
  whenever the user is not looking at the Browser surface, which is the common
  case in a Control-centric session.
- The mirror repaints from a fresh full snapshot on resume; no stale-DOM window.
- Backward compatible: an old host drops the unknown frame (whitelist), an old
  extension never receives it; in both cases capture simply keeps running, so a
  new client degrades gracefully. The contract is the wire frame, not the app
  version (extension bumped 0.3.0 → 0.4.0).
- Not covered (deliberate): the popup still shows "recording" while paused (the
  badge shows `PAUSE`); disconnect does not pause capture (the extension owns its
  own tab lifecycle). Both can fold into the future host-side browser-only
  session mode.

Relates to ADR-0038 (DOM lane), ADR-0040 (client->host reverse channel),
ADR-0042 (isolated-world recorder start/stop).
