# AgentDesk

A remote-desktop tool for one developer, one Mac, one iPhone, with **macOS Spaces as a first-class primitive**. Swipe three fingers on the phone, switch Spaces on the Mac.

## Why it exists

I run AI coding agents pinned to separate macOS Spaces. AnyDesk lets me reach the Mac from my phone, but it does not understand Spaces. Switching between agents from the couch means hunting for `Ctrl+Arrow` on a soft keyboard, which kills the flow that made the Spaces layout useful in the first place.

Secondary frustrations with AnyDesk on the phone: occasional black-canvas-with-a-floating-cursor failure mode, no native two-finger scroll or right-click, and mushy text on Retina-scale content.

AgentDesk is the smallest possible fix: a native iPhone client and a native macOS menu-bar host that ship pixels over an owned QUIC media channel, send input over a dedicated authenticated WebSocket, and add the Spaces gesture AnyDesk cannot provide.

This worktree is testing the ADR-0016 scroll-first hybrid retained-graphics path. HEVC remains the rest and full-frame correctness path. A sibling reliable graphics command channel is being added for scroll motion only.

## What it does

- Streams the active macOS Space to the iPhone at native pixel density.
- Accepts an AnyDesk-style trackpad: cursor move, tap-to-click, two-finger right-click, two-finger scroll, double-tap-drag.
- **Three-finger horizontal swipe on the phone switches Spaces on the Mac.**
- Compact keyboard with `Esc`, `Tab`, arrows, and sticky-tap modifiers (`Cmd`, `Ctrl`, `Option`, `Shift`).
- Drops the session within a second when the iPhone app backgrounds. Reconnects in under five when it foregrounds.
- Mac-initiated pairing: open the app on the phone, pick it from the Mac's tailnet device list, done. QR stays as a fallback.

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
  | KeyboardSurface      |    NormalizedInput     | Encoder (VideoToolbox)        |
  | VideoRenderer        | <===================>  | InputDispatcher (CGEventPost) |
  | RetainedCompositor*  |    graphics commands   | RegionCrispController         |
  | PairingClient        |    QUIC media packets  | SpacesProvider (private CGS)  |
  | OwnedMediaTransport  |                        | Pairing (picker + QR)         |
  | GraphicsTransport*   |                        | GraphicsTransport*            |
  +----------------------+                        | OwnedMediaTransport           |
                                                  +-------------------------------+
                          peers meet on Tailscale, no STUN/TURN/VPS
```

`*` marks the scroll-hybrid worktree target, not behavior already promoted to `main`.

Key choices:

- **Transport:** owned authenticated QUIC datagrams for HEVC full-frame refreshes, a sibling reliable graphics command channel on `AGENTDESK_GRAPHICS_PORT`, plus a dedicated TLS WebSocket for input. Both ends are on the tailnet, so the public-internet rendezvous machinery is not needed.
- **Codec and compositor:** Hardware HEVC via VideoToolbox remains the rest and full-frame correctness path. The current baseline decodes into `AVSampleBufferDisplayLayer`; the worktree target decodes HEVC with `VTDecompressionSession` into a retained BGRA compositor while graphics commands mutate the same surface during accepted scroll.
- **Graphics scope:** scroll-first hybrid retained graphics, not full Microsoft mixed mode. The branch targets `copyRect` plus lossless exposed-strip tiles for scroll motion. Full text/image/video classification, region HEVC, and codec atlas behavior remain future scope.
- **Spaces:** Private CoreGraphics calls (`CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners`) on the Mac. The 3-finger swipe lands as a synthesized `Ctrl+Arrow` event via `CGEventPost`, which is the same path the OS uses for the keyboard shortcut.
- **Pairing:** Open the app on the phone, then pick that iPhone from the Mac's tailnet device list. The Mac enumerates online iOS peers, probes each for a self-reported name, and pushes a pre-approved signed offer to the one you tap; the phone runs the unchanged handshake and the host auto-approves the pick. The phone stores a signed bearer token in the Keychain. QR stays as a fallback. No accounts, no server. See ADR-0019.

Module boundaries, wire shapes (`DesktopState`, `NormalizedInput`, `PairingPayload`), and performance budgets are in `SPEC.md`.

## Status

In active device-feel development. Pairing, session auth, input, cursor mirroring, Spaces switching, host overlays, and owned hardware media are implemented. This branch is the ADR-0016 scroll-first hybrid experiment: keep HEVC for crisp rest/full-frame refresh, add reliable retained graphics commands for scroll motion, and measure whether retained `copyRect` beats full-frame video during text scroll.

v0 is done when the author uses it as a daily driver without reaching for AnyDesk.

## How to run it

1. Install on the Mac: open the notarized DMG built from the host workspace, drag the app to `/Applications`, grant Screen Recording and Accessibility permissions on first launch.
2. Install on the iPhone: TestFlight invite, single device.
3. Both devices must be on the same Tailscale tailnet.
4. Open the iPhone app so it is foregrounded on its unpaired screen.
5. Open the Mac app, click the menu-bar icon, hit **Pair iPhone**. The Mac scans the tailnet and lists the iPhones that answered. Tap yours; it pairs with no typing and no QR. (QR remains a fallback.)
6. The iPhone shows the active Space at native DPR. Three-finger swipe switches Spaces.

For a development run on the connected iPhone:

```sh
just fresh-release-diagnostic-run
```

`fresh-release-diagnostic-run` rebuilds and relaunches the Mac host, updates the iPhone client in place without deleting its app data, and launches it with the console attached, preserving owned-media diagnostics in `/tmp/agentdesk-client-console.log`. The stable pair builds in Release so a feel or media-diagnosis read reflects shipped performance; a Debug host pegs a core in the crisp tile codec and distorts the motion. Configuration (the always_video carrier, keyframe interval, and so on) comes from baked code defaults and `.env`; see `.env.example` for the knobs. Two launch modes: `fresh-install` (Release, no console, returns immediately) and `fresh-release-diagnostic-run` (Release, console attached, blocks). Suffix either with `-dev` (`fresh-install-dev`, `fresh-diagnostic-run-dev`) to drive the side-by-side AgentDesk Dev build, which stays Debug for fast iteration.

## Repository layout

- `PRD.md` what we are building and why.
- `SPEC.md` how v0 is built. Stack, modules, wire shapes, budgets.
- `AGENTS.md` how to operate in this repo (conventions, voice, ADR process, work-breakdown rules). Read this if you are coding here, human or agent.
- `architecture-decisions/` one ADR per locked-in decision. ADR-0001 will record the stack.
- `mock-design/` design handoff bundle for visual reference only.
- `TASKS.md` current owned-media iteration ledger, with closed ledgers under `tasks/archive/`.

## License

Not set. Will be chosen alongside S8.
