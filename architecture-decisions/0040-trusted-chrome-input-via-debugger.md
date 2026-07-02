---
status: proposed
date: 2026-07-01
---

# Route phone taps back to Chrome as trusted input via chrome.debugger

## Context and Problem Statement

Read-only DOM mirroring (ADR-0038) shows a Chrome tab on the phone; this decision adds the write
direction: a tap on the mirror controls the real tab. The tap must arrive as a real user gesture
(`isTrusted: true`) or many sites and all native controls (file pickers, autoplay gates, security
prompts) ignore it. This touches the MV3 extension service worker (the input sink), the host's
`DomEventLaneServer` (which now also reads client taps), and `DomBridgeServer` (which relays them).

## Decision Drivers

- Input must be `isTrusted` so arbitrary sites honor it.
- The sink must stay decoupled from the Mac input path (`InputDispatcher`/CGEvents) — DOM input is a
  different world with a different blast radius.
- Bounded blast radius: a tap may only reach the tab the user chose to mirror, never arbitrary tabs.
- No relaunch of the user's browser, no external ports.

## Considered Options

- **Option A**: `chrome.debugger` (extension API) → `Input.dispatchMouseEvent`. In-process, `isTrusted`.
- **Option B**: Synthetic `MouseEvent`/`KeyboardEvent` from a content script (`isTrusted: false`).
- **Option C**: External CDP via `--remote-debugging-port`, driven by a separate process.

## Decision Outcome

Chose **Option A** because the `isTrusted` driver eliminates B (synthetic events are ignored by many
frameworks and can never trigger native UI), and the no-relaunch/no-external-port driver eliminates C
(it requires launching Chrome with a debugging flag and a separate connection). `chrome.debugger` is
an in-process extension API: no relaunch, no external port, and it produces genuinely trusted input.
The service worker attaches the debugger lazily to the **recording tab only** (`recordingTabId`) and
dispatches a mousePressed/mouseReleased pair at the page CSS-pixel coordinates the client already
mapped. The cost is the persistent "extension is debugging this browser" banner on that tab and the
one-debuggee-per-tab limit; both are acceptable for an opt-in remote-control feature.

Trust boundary: only the authenticated, paired phone can send taps, and only over the session's
`.dom` QUIC lane (client → host → bridge → extension). Taps are dispatched exclusively to the tab the
user is mirroring; the sink never touches `InputDispatcher` (the Mac CGEvent path). So the write
surface is exactly "the phone can click in the one tab it is already viewing" — inherent to the
feature, and no broader.

### Consequences

- Good, because taps are `isTrusted` and land on the real tab, so every site honors them.
- Good, because the input sink is fully decoupled from the Mac input path and bounded to one tab.
- Bad, because chrome.debugger shows a debugging banner and holds the tab's single debugger slot
  (DevTools can't be open on the same tab while attached).
- Neutral, because a new client→host direction is added on the `.dom` lane (its receive loop), rather
  than a separate stream — kept on the DOM lane so DOM input never mixes with Mac input.

### Confirmation

`just dom-mirror-input-verify` (autonomous) drives the write path deterministically: with the
recorder running on the fixture, a host-originated `dom-input` command is sent through the shim to the
extension, which dispatches it via chrome.debugger; a gated click-report from the content script
confirms a `isTrusted: true` click landed at the mapped coordinate. `DomInputCommand` wire round-trip
is unit-tested. The full phone-tap → Chrome round-trip is confirmed at the physical-device run.

## Links

- ADR-0038 DOM mirror over a dedicated reliable QUIC lane
- ADR-0039 native-messaging bridge with a sacrificial shim
- chrome.debugger — https://developer.chrome.com/docs/extensions/reference/api/debugger
- CDP Input.dispatchMouseEvent — https://chromedevtools.github.io/devtools-protocol/tot/Input/
