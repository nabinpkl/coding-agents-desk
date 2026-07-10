# AgentDesk PRD

> Authoritative for **what** we are building and **why**. Implementation shape lives in `SPEC.md`. Repo operating rules live in `AGENTS.md`.

## One-line thesis

AgentDesk is the single-user agent workspace spanning one macOS host and one iPhone: workspace files, terminals, agent activity, browser context, remote control, and macOS Spaces have one owner and one authenticated client.

## Who it is for

One user (the author). One macOS host. One iPhone client. Tailscale already on both ends. No multi-user, no teams, no marketplace.

## Problem

The author's coding work is split across project folders, terminals, agents, browser windows, and macOS Spaces. AgentDesk already owns remote control, Spaces, PTYs, and ATC activity, while the sibling `agent-workspace-ide` owns the workspace sidebar and file editor. Two applications leave workspace state and control fragmented, and the iPhone cannot browse or edit the same authoritative workspace files.

Secondary pain: AnyDesk on phone often degrades to a black canvas with a moving cursor, no native trackpad gestures (two-finger scroll, right-click, drag), and text crispness on Retina-scale content is mushy.

## Solution

Native iOS app plus native macOS menu-bar workspace host, paired over Tailscale. The host owns registered workspace roots, an auto-hiding AppKit sidebar and top bar, editable local file windows, PTY sessions, ATC activity, browser integration, Spaces, and hardware-encoded remote desktop. The iPhone projects the same system through purpose-built Control, Agents, Files, Terminal, and Browser surfaces.

The macOS host also owns a local **Space Agent** overlay: a small draggable spaceship that stays visible while the host app runs. Clicking the spaceship expands an attached Spaces panel showing live thumbnails for the active display's user Spaces; clicking a non-active Space switches the Mac to it. This is a host-side desktop navigator, not the iPhone remote-control surface.

## v0 acceptance

Empirical, not duration-based. The author uses AgentDesk for agent control; v0 ships when the qualitative friction list reaches steady state. The "AnyDesk reach" metric is retired because AnyDesk does not navigate macOS Spaces, so it cannot measure the v0 thesis gesture against itself. Felt friction (cursor lag, text legibility, reconnect speed, Spaces parity, dead UI regions) is the acceptance signal.

## v0 user surface

1. Pair iPhone to Mac once from the Mac: open the app on the phone, then pick that iPhone from the Mac's tailnet device list. The host-side pick is the authorization. QR scanning remains a fallback.
2. Open iPhone app, see the active Space at native DPR.
3. Trackpad area accepts: cursor move, tap-to-click, two-finger right-click, two-finger scroll, double-tap-drag.
4. **One-handed Spaces control switches Spaces.** Visible feedback within one frame.
5. On multi-monitor hosts, pick the projected display from a labeled client rail. The Spaces control then switches Spaces on that selected display.
6. Compact keyboard with Esc, Tab, arrows, and sticky-tap modifiers (Cmd, Ctrl, Option, Shift).
7. When the iPhone app backgrounds, the session drops within one second. Foregrounding reconnects in under five seconds.
8. macOS host runs as a menu-bar app that auto-starts when the user actively opens it (not on every boot).
9. macOS host shows a persistent draggable Space Agent. The small spaceship toggles an attached active-display Spaces panel with live thumbnails; selecting a non-active tile switches Spaces and leaves the panel open.
10. macOS host starts an auto-hiding workspace sidebar and top bar while remaining a menu-bar application with no Dock icon.
11. Add project folders as persistent workspaces, browse their files, and open text, Markdown, HTML, and notebooks in the host-owned viewer/editor.
12. Edit workspace files locally with atomic autosave and visible external-change conflicts.
13. Open a macOS Agents window from the top bar and browse all ATC projects, sessions, history, and live activity.
14. On iPhone, browse the same registered workspace roots, preview files, edit UTF-8 text, and save only when the host revision still matches.

## What v0 is not

- **Read-only agent feed, not the full agent-native UX.** v0 includes a read-only agent-feed surface on the phone: a project-first list of observed projects, each combining Claude and Codex threads, scrolled natively, fed by the host from local transcript normalization over the existing session (ADR-0035). It does **not** include the richer agent-native UX mocked in `mock-design/`: no per-agent attention model, no live reasoning ticker as a control surface, no swipe-between-agents carousel, and no acting on agents from the phone (reply, approve, nudge). The host-side Space Agent remains a local Spaces navigator, distinct from this phone-side feed.
- **Not continuous multi-display gestures.** Display selection is an explicit tap on the client rail. Horizontal sliding remains dedicated to switching Spaces within the selected display.
- **Not multi-user.** Single bearer token in Keychain. No accounts, no sharing.
- **Not internet-routable.** Tailscale-only. No STUN, no TURN, no VPS, no relay.
- **Not cross-platform.** macOS host and iOS client only. No Android, no web, no Windows host.
- **No arbitrary filesystem or bulk file-transfer surface.** Files are exposed only through registered workspace roots. The iPhone file lane supports bounded UTF-8 browse, read, and revision-checked write operations, not downloads from unrelated host paths. Clipboard sync and remote audio remain out of scope. One host-local exception remains the push-to-talk dictation bar (ADR-0010).

## Explicitly deferred

- Agent-native UX (per-agent attention model, reasoning surface, multi-agent overview).
- iPad client (later iteration, same codebase).
- Browser client. AnyDesk and TeamViewer do not ship a mobile browser client either; chasing crisp text in a browser is not the v0 fight.
- Marketplace / TestFlight wider distribution. v0 is signed Developer ID DMG for Mac and TestFlight to one device for iOS.
- Debug Browser, Jupyter execution, Dock enrichment, and duplicate Desktop orchestration from the retiring `agent-workspace-ide` donor. They move only through later product decisions, not as incidental porting.

## Source of truth for detail

- **44 user stories**: GitHub issue [#1](https://github.com/nabinpkl/agent-desk/issues/1).
- **Implementation shape and module boundaries**: `SPEC.md`.
- **Vertical-slice execution plan**: GitHub issues #2 through #10 and (when opened) `TASKS.md`.
