# AgentDesk

A remote-desktop tool for one developer, one Mac, one iPhone, with **macOS Spaces as a first-class primitive**. Swipe three fingers on the phone, switch Spaces on the Mac.

## Why it exists

I run AI coding agents pinned to separate macOS Spaces. AnyDesk lets me reach the Mac from my phone, but it does not understand Spaces. Switching between agents from the couch means hunting for `Ctrl+Arrow` on a soft keyboard, which kills the flow that made the Spaces layout useful in the first place.

Secondary frustrations with AnyDesk on the phone: occasional black-canvas-with-a-floating-cursor failure mode, no native two-finger scroll or right-click, and mushy text on Retina-scale content.

AgentDesk is the smallest possible fix: a native iPhone client and a native macOS menu-bar host that ship pixels and input over WebRTC, with a single new gesture that does the thing AnyDesk cannot.

## What it does

- Streams the active macOS Space to the iPhone at native pixel density.
- Accepts an AnyDesk-style trackpad: cursor move, tap-to-click, two-finger right-click, two-finger scroll, double-tap-drag.
- **Three-finger horizontal swipe on the phone switches Spaces on the Mac.**
- Compact keyboard with `Esc`, `Tab`, arrows, and sticky-tap modifiers (`Cmd`, `Ctrl`, `Option`, `Shift`).
- Drops the session within a second when the iPhone app backgrounds. Reconnects in under five when it foregrounds.
- One-shot QR pairing on the same tailnet.

## What it is not

- **Not agent-native UI.** The polished agent carousel and reasoning ticker in `mock-design/` are a v1+ direction, not what v0 ships. v0 is AnyDesk minus the pain points, plus the swipe.
- Not multi-user. Not multi-host. Not internet-routable.
- No file transfer, no clipboard sync, no audio.
- Not Android, not Windows, not a browser client. Native iOS plus native macOS only.

The full non-goal list is in `PRD.md`.

## Architecture in one diagram

```
  iPhone (Swift / UIKit)                          Mac (Swift / AppKit menu-bar)
  +----------------------+                        +-------------------------------+
  | GestureTranslator    |                        | CaptureEngine (ScreenCapture) |
  | KeyboardSurface      |    NormalizedInput     | Encoder (VideoToolbox HEVC)   |
  | VideoRenderer        | <===================>  | InputDispatcher (CGEventPost) |
  | PairingClient        |    HEVC video track    | SpacesProvider (private CGS)  |
  | Transport (libwebrtc)|                        | Pairing (QR + Keychain)       |
  +----------------------+                        | Transport (libwebrtc)         |
                                                  +-------------------------------+
                          peers meet on Tailscale, no STUN/TURN/VPS
```

Key choices:

- **Transport:** WebRTC over Tailscale. Both ends are on the tailnet, so the public-internet rendezvous machinery is not needed.
- **Codec:** Hardware HEVC via VideoToolbox on both ends, decoded into `AVSampleBufferDisplayLayer` at native DPR. This is what buys text crispness.
- **Spaces:** Private CoreGraphics calls (`CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners`) on the Mac. The 3-finger swipe lands as a synthesized `Ctrl+Arrow` event via `CGEventPost`, which is the same path the OS uses for the keyboard shortcut.
- **Pairing:** Scan a QR on the Mac. The phone stores a signed bearer token in the Keychain. No accounts, no server.

Module boundaries, wire shapes (`DesktopState`, `NormalizedInput`, `PairingPayload`), and performance budgets are in `SPEC.md`.

## Status

Early. No code yet, only the design bundle in `mock-design/` and the planning artifacts in this repo. Execution is broken into nine vertical slices on GitHub:

| Issue | Slice | Mode |
| --- | --- | --- |
| [#2](https://github.com/nabinpkl/agent-desk/issues/2) | S0: stack ADR, repo skeleton, signing | HITL |
| [#3](https://github.com/nabinpkl/agent-desk/issues/3) | S1: QR pairing | AFK |
| [#4](https://github.com/nabinpkl/agent-desk/issues/4) | S2: hello-pixels (capture, encode, render) | AFK |
| [#5](https://github.com/nabinpkl/agent-desk/issues/5) | S3: cursor and basic click | AFK |
| [#6](https://github.com/nabinpkl/agent-desk/issues/6) | S4: full trackpad gestures | AFK |
| [#7](https://github.com/nabinpkl/agent-desk/issues/7) | S5: Spaces enumeration and 3-finger swipe | AFK |
| [#8](https://github.com/nabinpkl/agent-desk/issues/8) | S6: keyboard and accessory row | AFK |
| [#9](https://github.com/nabinpkl/agent-desk/issues/9) | S7: lifecycle and reconnect | AFK |
| [#10](https://github.com/nabinpkl/agent-desk/issues/10) | S8: distribution and 7-day self-test | HITL |

v0 is "done" when the author uses it as a daily driver for **seven consecutive days** without reaching for AnyDesk.

## How to run it

There is nothing to run yet. Once S2 lands, this section will become the real instructions. The shape they will take:

1. Install on the Mac: open the notarized DMG built from the host workspace, drag the app to `/Applications`, grant Screen Recording and Accessibility permissions on first launch.
2. Install on the iPhone: TestFlight invite, single device.
3. Both devices must be on the same Tailscale tailnet.
4. Open the Mac app, click the menu-bar icon, hit **Pair**. A QR appears.
5. Open the iPhone app, scan the QR. The token lands in the Keychain on both ends.
6. The iPhone shows the active Space at native DPR. Three-finger swipe switches Spaces.

Until S2 lands, the only thing to "run" is the design prototype: open `mock-design/project/index.html` in a browser to see the visual target.

## Repository layout

- `PRD.md` what we are building and why.
- `SPEC.md` how v0 is built. Stack, modules, wire shapes, budgets.
- `AGENTS.md` how to operate in this repo (conventions, voice, ADR process, work-breakdown rules). Read this if you are coding here, human or agent.
- `architecture-decisions/` one ADR per locked-in decision. ADR-0001 will record the stack.
- `mock-design/` design handoff bundle for visual reference only.
- `TASKS.md` will appear when the first iteration opens.

## License

Not set. Will be chosen alongside S8.
