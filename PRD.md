# AgentDesk PRD

> Authoritative for **what** we are building and **why**. Implementation shape lives in `SPEC.md`. Repo operating rules live in `AGENTS.md`.

## One-line thesis

AgentDesk is an AnyDesk replacement for one solo developer controlling one macOS host from an iPhone, with **macOS Spaces as a first-class primitive** on both the iPhone client and the Mac host.

## Who it is for

One user (the author). One macOS host. One iPhone client. Tailscale already on both ends. No multi-user, no teams, no marketplace.

## Problem

AnyDesk works as a remote viewer but is space-agnostic. The author runs AI coding agents pinned to separate macOS Spaces and wants to thumb between them from the phone the same way a 3-finger swipe moves between Spaces locally. Today that requires hunting for the `Ctrl+Arrow` shortcut on a soft keyboard, which breaks the flow that makes Spaces useful in the first place.

Secondary pain: AnyDesk on phone often degrades to a black canvas with a moving cursor, no native trackpad gestures (two-finger scroll, right-click, drag), and text crispness on Retina-scale content is mushy.

## Solution

Native iOS app plus native macOS menu-bar host, paired over Tailscale, streaming HEVC over WebRTC. The iPhone shows the active Space at native DPR with an AnyDesk-style trackpad and a compact keyboard, plus a one-handed Spaces control that drives the host's native Spaces transition.

The macOS host also owns a local **Space Agent** overlay: a small draggable spaceship that stays visible while the host app runs. Clicking the spaceship expands an attached Spaces panel showing live thumbnails for the active display's user Spaces; clicking a non-active Space switches the Mac to it. This is a host-side desktop navigator, not the iPhone remote-control surface.

## v0 acceptance

Empirical, not duration-based. The author uses AgentDesk for agent control; v0 ships when the qualitative friction list reaches steady state. The "AnyDesk reach" metric is retired because AnyDesk does not navigate macOS Spaces, so it cannot measure the v0 thesis gesture against itself. Felt friction (cursor lag, text legibility, reconnect speed, Spaces parity, dead UI regions) is the acceptance signal.

## v0 user surface

1. Pair iPhone to Mac once by scanning a QR code on the Mac.
2. Open iPhone app, see the active Space at native DPR.
3. Trackpad area accepts: cursor move, tap-to-click, two-finger right-click, two-finger scroll, double-tap-drag.
4. **One-handed Spaces control switches Spaces.** Visible feedback within one frame.
5. Compact keyboard with Esc, Tab, arrows, and sticky-tap modifiers (Cmd, Ctrl, Option, Shift).
6. When the iPhone app backgrounds, the session drops within one second. Foregrounding reconnects in under five seconds.
7. macOS host runs as a menu-bar app that auto-starts when the user actively opens it (not on every boot).
8. macOS host shows a persistent draggable Space Agent. The small spaceship toggles an attached active-display Spaces panel with live thumbnails; selecting a non-active tile switches Spaces and leaves the panel open.

## What v0 is not

- **Not agent-native.** No agent cards, no per-agent reasoning ticker, no swipe-between-agents carousel. The host-side Space Agent is a local Spaces navigator, not the v1+ agent-native UX mocked in `mock-design/`.
- **Not multi-display in the UI.** The host knows about multiple displays; the client only shows the active Space on the active display in v0.
- **Not multi-user.** Single bearer token in Keychain. No accounts, no sharing.
- **Not internet-routable.** Tailscale-only. No STUN, no TURN, no VPS, no relay.
- **Not cross-platform.** macOS host and iOS client only. No Android, no web, no Windows host.
- **No file transfer, no clipboard sync, no audio.** v0 ships pixels and input only.

## Explicitly deferred

- Agent-native UX (per-agent attention model, reasoning surface, multi-agent overview).
- Multi-display projection on the client.
- iPad client (later iteration, same codebase).
- Browser client. AnyDesk and TeamViewer do not ship a mobile browser client either; chasing crisp text in a browser is not the v0 fight.
- Marketplace / TestFlight wider distribution. v0 is signed Developer ID DMG for Mac and TestFlight to one device for iOS.

## Source of truth for detail

- **44 user stories**: GitHub issue [#1](https://github.com/nabinpkl/agent-desk/issues/1).
- **Implementation shape and module boundaries**: `SPEC.md`.
- **Vertical-slice execution plan**: GitHub issues #2 through #10 and (when opened) `TASKS.md`.
