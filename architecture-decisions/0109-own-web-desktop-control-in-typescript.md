---
status: accepted
date: 2026-08-27
---

# Own first-party WebView desktop control in TypeScript

## Context and Problem Statement

The first-party desktop viewer already owns pointer, zoom, scroll, and cursor-follow behavior in a
live TypeScript surface, but remote keyboard presentation and focus decisions remained native. That
split made interaction changes require an iOS build and gave pointer and keyboard separate state and
diagnostic authorities. The WebRTC stream already has one low-latency ordered data channel and a
standalone capture helper that can provide the two capabilities WebKit lacks: Accessibility focus
inspection and trusted `CGEvent` injection.

## Decision Drivers

- WebView interaction and diagnostic changes must require zero app rebuild, reinstall, or relaunch.
- Pointer, scroll, cursor feedback, focus, keyboard delivery, and ownership need one ordered contract.
- WebKit must synchronously focus its capture field inside the user's tap gesture to summon the iOS
  software keyboard.
- Secure text, delivery receipts, reconnects, and ownership loss must never retain or replay plaintext.
- Accessibility and event injection stay outside the page and fail explicitly.

## Considered Options

- **Option A**: Keep native keyboard presentation beside the TypeScript pointer surface.
- **Option B**: Add a native focus portal while moving the remaining keyboard behavior to TypeScript.
- **Option C**: Let TypeScript own the complete first-party WebView control system and keep only AX
  sampling plus `CGEvent` posting in the standalone helper.

## Decision Outcome

Chose **Option C**. `agentdesk-control-v2` is the only first-party WebRTC desktop-control data channel.
The shared TypeScript wire module defines pointer, scroll, key-batch, focus-query, release, cursor,
focus, delivery, and ownership messages. The sidecar validates 16 KiB messages, 256-event batches,
sequence numbers, UUID correlation IDs, and the closed ANSI key set, then forwards canonical NDJSON
without interpreting keyboard behavior. It grants the latest intentional interaction one ownership
epoch and revokes the previous controller.

The AgentPanel reducer and DOM adapter own pre-arming, the 700 ms focus window, a 32-event pending
buffer, stale response suppression, sticky modifiers, atomic paste/composition encoding, acknowledged
receipt state, Auto preference, dismissal, visual-viewport placement, and privacy-bounded telemetry.
The standalone helper owns only AX trust and classification, delayed focus probing, stable ANSI key
lookup, direct modifier flags, serial key-down/key-up posting, pointer injection, and explicit native
results. Capability metadata requires `desktopControlVersion: 2`; mismatch leaves video viewable but
disables control loudly. There is no pointer-v1 or native-keyboard compatibility fallback.

The synchronous pre-arm may briefly show the iOS keyboard after a non-text tap. This is accepted
because a later asynchronous focus callback normally cannot summon it. If that flash is unacceptable,
the alternative is a one-time native focus portal without changing the rest of this ownership model.

The accessory distinguishes immediate local typing echo from acknowledged delivery. The echo is a
bounded local line, not remote text or caret synchronization; Backspace edits it and Return clears it.
Secure and unclassified focus masks it. The receipt remains acknowledgement-only. Both clear on
dismissal, disconnect, and ownership loss. This restores typing feedback without claiming that local
acceptance means the Mac applied the input.

The iOS desktop container suppresses WebKit's native form-navigation/Done accessory through the public
`WKWebView.inputAccessoryView` override. This opt-in shell policy leaves other panels unchanged and
does not move input, focus arbitration, or accessory rendering out of TypeScript.

### Consequences

- Good, because interaction, keyboard, and diagnostics now update through the live TypeScript origin.
- Good, because applied receipts and secure masking are correlated to one ordered channel and never
  replay across reconnect or ownership loss.
- Good, because Bun and Swift consume one golden control fixture and native key batches are
  prevalidated before any event is posted.
- Bad, because a rejected non-text tap can briefly flash the system keyboard.
- Neutral, because changing AX or `CGEvent` behavior still requires rebuilding the standalone helper
  and reopening the stream, but does not change either app bundle.

### Confirmation

- Repository search finds no `agentdesk-pointer-v1`, `WebrtcPointerInput`, or pointer command parser.
- TypeScript tests cover reducer correlation, timeout behavior, ANSI encoding, modifiers, secure
  receipts, DOM capture, composition, hardware-key deduplication, and dismiss-and-consume arbitration.
- Sidecar tests cover bounds, canonical NDJSON, native event validation, and ownership epochs.
- Native tests inject trust and event-posting seams, exercise every fixture ANSI key, direct modifier
  flags, down/up ordering, batch atomicity, AX classification, and exact `K`/`B<number>` parsing.

## Links

- `SPEC.md` First-party WebView desktop control
- ADR-0005 Input channel separation
- ADR-0058 Sequenced cursor reconciliation with explicit host provenance
- ADR-0095 Relay the agent feed instead of restating it in Swift
- WebKit issue 195884, 2019-03-18: https://bugs.webkit.org/show_bug.cgi?id=195884
