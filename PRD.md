# AgentDesk PRD

> Authoritative for **what** we are building and **why**. Implementation shape lives in `SPEC.md`. Repo operating rules live in `AGENTS.md`.

## One-line thesis

AgentDesk is the single-user agent workspace spanning one macOS host and one iPhone: workspace files, terminals, agent activity, browser context, remote control, and macOS Spaces have one owner and one authenticated client.

## Who it is for

One user (the author). One macOS host. One iPhone client. Tailscale already on both ends. No multi-user, no teams, no marketplace.

## Problem

The author's coding work is split across project folders, terminals, agents, browser windows, and macOS Spaces. AgentDesk already owned remote control, Spaces, PTYs, and agent activity, while the sibling `agent-workspace-ide` owned the workspace sidebar and file editor — two applications that left workspace state and control fragmented, with the iPhone unable to browse or edit the same authoritative workspace files. AgentDesk has since absorbed the workspace shell, local editing, and terminal packages and retired that donor (ADR-0052, ADR-0053), so one application now owns the authoritative workspace.

Secondary pain: AnyDesk on phone often degrades to a black canvas with a moving cursor, no native trackpad gestures (two-finger scroll, right-click, drag), and text crispness on Retina-scale content is mushy.

## Solution

Native iOS app plus native macOS menu-bar workspace host, paired over Tailscale. The host owns registered workspace roots, an auto-hiding AppKit sidebar and top bar, editable local file windows, PTY sessions, agent activity, browser integration, Spaces, and hardware-encoded remote desktop. The iPhone projects the same system through purpose-built Control, Agents, Workspace, IDE, Terminal, and Browser surfaces. The embedded IDE is a shared responsive WebKit workbench inside native AppKit and UIKit pane shells; it is not an internet browser client.

Persistent PTY sessions keep their master descriptors in a small Rust vault while the replaceable Rust
manager owns bounded terminal display state, not a viewer. A late or restored macOS/iOS client
reconstructs the shared logical grid from a memory-only checkpoint and fits it locally while readable,
then clips a cursor-following viewport at a local scale floor. Vault and manager code updates hand over
live descriptors and bounded manager state without replacing the running shell or TUI.
The last selected or interacted-with active viewer automatically owns that shared grid's rows and
columns; passive changes in another viewer remain presentation-only. Followers display the owner's
grid through local fit, crop, padding, and cursor following. AgentDesk persists standalone window
placement metadata but never terminal text, scrollback, ANSI, checkpoints, typed input, viewport
reports, or ownership state (ADR-0066, ADR-0067, ADR-0068).

Every terminal surface uses one bundled responsive WKWebView and xterm.js workspace runtime. Full
Terminal surfaces share tabs, recursive splits, pane chrome, session discovery, rendering, and input
behavior across macOS and iOS. Embedded Agent and Workspace terminals use the same runtime with
management controls hidden. Thin AppKit and UIKit adapters retain only platform lifecycle and OS
integration; the Rust manager remains authoritative for terminal state and replies (ADR-0069).

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
13. Open independent macOS Agents windows from the top-bar `＋ Agents` command on the current Desktop and browse discovered Claude and Codex projects, sessions, history, and live activity.
14. On iPhone, browse the same registered workspace roots, preview files, edit UTF-8 text, and save only when the host revision still matches.
15. On macOS, inspect running apps by Desktop in the bottom Dock-enrichment strip, focus an exact
    Desktop-scoped window without moving it, and transactionally swap the ordinary window contents of
    two existing Desktops with a short conservative Undo.
16. Open a separate Workspace IDE on macOS or iPhone with the same Explorer, read-only Source Control, shared open tabs, file editor/viewer, and shared web terminal rooted at the selected workspace. Tab membership and expanded folders synchronize through the host while each device keeps its own active tab, selected workspace, pane layout, drafts, and cursor positions.
17. Open the Browser Projection on macOS or iPhone showing every normal Chrome window, the selected window's ordered tabs, and one reconstructed active page. AgentDesk may select a projected window without raising Chrome and may activate a tab without focusing its Chrome window. The last active Browser viewer controls the real tab's responsive source viewport, with Desktop, Mobile, custom dimensions, viewer-linked sizing, and projection-only zoom in the shared shell. Hiding the final viewer restores native Chrome behavior. Both platforms share one extension recorder.
18. For visual debugging, explicitly opt in on the iPhone and let the paired Mac request one bounded
    screenshot of the currently visible AgentDesk app window. The client remains foreground-only,
    shows an accessible disclosure after sharing, stores no screenshot, and supports one command that
    collects the image alone or beside bounded durable diagnostics.

## What v0 is not

- **Read-only agent feed, not the full agent-native UX.** v0 includes a read-only agent-feed surface on the phone: a project-first list of observed projects, each combining Claude and Codex threads, scrolled natively, fed by the host from local transcript normalization over the existing session (ADR-0035). It does **not** include the richer agent-native UX mocked in `mock-design/`: no per-agent attention model, no live reasoning ticker as a control surface, no swipe-between-agents carousel, and no acting on agents from the phone (reply, approve, nudge). The host-side Space Agent remains a local Spaces navigator, distinct from this phone-side feed.
- **Not continuous multi-display gestures.** Display selection is an explicit tap on the client rail. Horizontal sliding remains dedicated to switching Spaces within the selected display.
- **Not multi-user.** Single bearer token in Keychain. No accounts, no sharing.
- **Not internet-routable.** Tailscale-only. No STUN, no TURN, no VPS, no relay.
- **Not cross-platform.** macOS host and iOS client only. No Android, no web, no Windows host.
- **No arbitrary filesystem or bulk file-transfer surface.** Files are exposed only through registered workspace roots. The iPhone file lane supports bounded UTF-8 browse, read, and revision-checked write operations, not downloads from unrelated host paths. Clipboard sync and remote audio remain out of scope. One host-local exception remains the push-to-talk dictation bar (ADR-0079).
- **No Chrome management surface.** Browser Projection does not create, close, reorder, pin, group, navigate, reload, resize, move, or focus Chrome windows. It selects only an existing projected window or an existing tab.
- **No continuous client screenshot telemetry.** Paired-client screenshots are explicit, default-off,
  foreground-only debugging captures. There is no background capture, scheduled upload, client pixel
  history, cloud destination, or general host access to other iOS apps and system windows.

## Explicitly deferred

- Agent-native UX (per-agent attention model, reasoning surface, multi-agent overview).
- iPad client (later iteration, same codebase).
- Internet-accessible browser client. The embedded Workspace IDE uses bundled WebKit inside the signed native apps and does not expose workspace authority over HTTP.
- Marketplace / TestFlight wider distribution. v0 is signed Developer ID DMG for Mac and TestFlight to one device for iOS.
- Debug Browser, Jupyter execution, and duplicate Desktop creation or reordering from the retired `agent-workspace-ide` donor. Dock enrichment returned through ADR-0055; content swap exchanges windows between existing Desktops without creating, deleting, or reordering Spaces (ADR-0059).

## Source of truth for detail

- **44 user stories**: GitHub issue [#1](https://github.com/nabinpkl/agent-desk/issues/1).
- **Implementation shape and module boundaries**: `SPEC.md`.
- **Vertical-slice execution plan**: GitHub issues #2 through #10 and (when opened) `TASKS.md`.
