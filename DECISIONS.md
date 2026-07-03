# DECISIONS

Load-bearing decisions made by an agent while implementing work, where the choice was not fully
dictated by the prompt or an existing ADR. Each entry states the decision, the evidence behind it, and
why it was made independent of any instruction. Architectural decisions that lock a contract still get
a full ADR under `architecture-decisions/`; this file captures the smaller judgement calls that would
otherwise be invisible.

## ADR-0047 Browser scroll-drive-back / pinch-zoom / mobile-emulation (Phases 1-3)

### D1. Autonomous simulator + CDP-Chrome verification was run without the per-run device checkpoint

AGENTS.md makes any host/client install, launch, or sim drive a STOP-and-wait checkpoint. For this
work the user explicitly and durably authorized autonomous driving of "cdp enabled debug chrome where
extension will be installed by you autonomously and autonomously driving the sim scroll etc". That
standing authorization overrides the per-run checkpoint for the throwaway Chrome-for-Testing profiles
and the local simulator only. The PHYSICAL iPhone (`dom-mirror-device-run`) stays a human checkpoint,
because the daily-driver device protection is not what the authorization was about.

### D2. The scroll sign convention passes the finger delta straight to CDP (no negation)

The plan sketched `Input.synthesizeScrollGesture` with `yDistance: -dy`. That is wrong. Empirically
(the `dom-mirror-scroll-verify` gate, run against the live extension) a POSITIVE `yDistance` scrolls the
content toward the TOP (window.scrollY decreases); negative scrolls down. So to make the mirrored
content follow the finger (finger drags down -> content moves down -> scrollY decreases), the phone's
finger delta (positive dy = finger down) is passed straight through: `yDistance = dy`, `xDistance = dx`.
The gate confirms it end-to-end: finger-up scrolls the page down (scrollY 0 -> 600), finger-down scrolls
back up (600 -> 0). This is documented inline in `chrome-extension/worker.js` `dispatchScroll` and in
both `DomScrollCommand` twins so the three boundaries agree.

### D3. Two deterministic autonomous gates were added instead of relying only on the physical run

The DOM-mirror scroll path previously would have been verifiable only at the physical `dom-mirror-device-run`
checkpoint. To make the work self-verifying (and to regression-guard the D2 sign bug and a sub-threshold
tap/scroll bug found in review), two headless gates were added, both modeled on the existing
`dom-mirror-input-verify` pattern:
- `dom-mirror-scroll-verify` (`chrome-test/scroll-verify.mjs`): the worker/CDP WRITE path. A fake host
  sends `dom-scroll` through the shim to the real extension, which drives a real Chrome tab; the harness
  reads `window.scrollY` to confirm direction. This is where D2 was ground-truthed.
- `dom-mirror-scroll-gesture-verify` (`chrome-test/scroll-gesture-verify.mjs`): the client gesture state
  machine. Loads the shipping `index.html`, gives it a surface via a CDP keyframe, dispatches synthetic
  TouchEvents, and asserts the threshold deadzone, tap-vs-scroll suppression, and multi-touch
  deactivation. This is the half no other test covers.
