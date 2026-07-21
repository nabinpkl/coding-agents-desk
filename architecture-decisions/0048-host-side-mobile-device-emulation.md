---
status: accepted
date: 2026-07-02
superseded-by: ADR-0065
---

# True mobile layout via host-side Chrome device emulation, echoed authoritatively on the batch

## Context

[ADR-0047](0047-dom-mirror-pure-viewport-mirror.md) fixed the invariant that the DOM-mirror client is
a pure viewport mirror: it shows exactly what the host tab renders and never reflows the page. That
ADR also named the consequence: seeing a page as *mobile* cannot be a client-side reflow (the replay
has no live JS and the captured DOM is the desktop DOM), so true mobile must be a **host-side**
decision that re-renders the real tab, whose true mobile layout then streams back through the normal
rrweb pipeline.

Phase 1 (scroll-drive-back) and Phase 2 (pinch-zoom) landed the two client-local invariant-preserving
slices. This ADR records how the host-side mobile toggle is built.

## Decision

A **Desktop | Mobile** control on the client's Browser status bar drives Chrome device emulation on the
recorded tab. The command rides the existing client->host `.dom` reverse channel as a new discrete
`t`-tagged frame, `dom-emulate {mobile: Bool}`, whitelisted in `DomEventLaneServer` exactly like
`dom-input`/`dom-scroll`; the host forwards it verbatim to the extension.

### Emulation mechanism

The extension worker, reusing its already-attached `chrome.debugger` session (same banner cost taps and
scroll already pay), applies:

- Mobile: `Emulation.setDeviceMetricsOverride {width:390, height:844, deviceScaleFactor:3, mobile:true}`
  + `Emulation.setTouchEmulationEnabled {enabled:true}` + a mobile `Emulation.setUserAgentOverride`.
  390x844 is the iPhone 12/13/14 CSS viewport, a mainstream target that triggers the common mobile
  breakpoints. The mirrored page needs a `width=device-width` viewport meta for the emulated width to
  take effect; a page with no viewport meta falls back to Chrome's legacy 980px mobile layout.
- Desktop: `Emulation.clearDeviceMetricsOverride` + `setTouchEmulationEnabled {enabled:false}` +
  restore the UA (CDP has no UA-override clear, so the pristine UA is captured on the first emulate and
  set back on desktop).

Emulation changes the metrics but does not itself re-serialize the DOM, so the worker then sends the
recorded tab an `agentdesk-resnapshot` message; the isolated-world recorder calls
`rrweb.record.takeFullSnapshot(true)` (the same primitive it already uses for SPA-nav keyframes), and
the next flush emits a checkout batch carrying the new `meta.w/h` (the emulated viewport). The mirror
repaints to the true mobile layout because the real page ran its own mobile code path.

### Lifecycle

`deviceEmulationEnabled` is worker state that **persists across capture pause/resume** (ADR-0045) so
returning to the Browser surface keeps the emulated view, but **resets to desktop** on
`startTabRecording`, `stopTabRecording`, tab removal, navigation, and debugger detach, because those all
begin (or end) a session whose fresh tab has no override. This mirrors the existing `cdpMode` reset
discipline so emulation can never silently follow a tab switch onto a tab that did not opt in.

### Authoritative state echo

The client reflects the **host's** emulation state rather than an optimistic local guess, so a host-side
reset self-corrects the toggle. The source of truth is the extension (it owns `deviceEmulationEnabled`),
and the `onInput` command path bypasses the relay, so the echo cannot come from the command. Instead the
worker stamps `em:<bool>` onto every `agentdesk-batch`; `DomBatchEnvelope` decodes it; `DomMirrorRelay`
holds it in state and includes `emulated` in the `dom-status` frame it already fans to clients; the
client's segmented control and a `mobile`/`desktop` status chip track that authoritative value.

## Consequences

- True mobile rendering is correct (the real page ran its mobile path), consistent with ADR-0047; the
  client stays a dumb mirror with one extra command and one extra status field.
- The debugger banner is shown while emulated (same as tap/scroll), which is acceptable given the user
  explicitly toggled it.
- Emulation is single-tab v1, matching the rest of the DOM-mirror surface.
- The extension bumps to 0.6.0 (tiered-fidelity + emulation). The host<->extension compatibility remains
  the wire protocol (the `dom-batch` envelope gains an optional `em`; older peers omit it and read
  desktop), not the app version.

Relates to ADR-0038 (DOM lane), ADR-0040 (client->host reverse channel), ADR-0045 (capture
pause/resume), ADR-0046 (diagnostic status line), ADR-0047 (pure viewport mirror).
