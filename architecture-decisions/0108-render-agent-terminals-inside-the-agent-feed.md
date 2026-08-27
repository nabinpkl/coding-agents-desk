---
status: proposed
date: 2026-08-26
supersedes: ADR-0056
---

# Render agent terminals inside the Agent Feed

## Context and Problem Statement

ADR-0056 put the selected agent terminal in a second native WebView and made AppKit, UIKit, and Swift
terminal coordination part of every change to its layout and transport. The AgentPanel now already
reaches the sidecar through one authenticated HTTP relay on macOS and iOS, and its live TypeScript
origin can update without rebuilding, reinstalling, or relaunching either app. The Agent Feed terminal
should use that existing projection while keeping PTY identity and process state outside the page.

## Decision Drivers

- Terminal presentation and interaction changes must require zero Swift compilation.
- The same AgentPanel code must render on macOS, iOS, and an ordinary authenticated browser surface.
- The Sessions/Bots sidebar and terminal must have one responsive layout owner, with no native overlay.
- Web content must not choose an executable, interpolate a shell command, read the control token, or
  speak directly to the PTY-manager socket.
- The Rust PTY manager must remain authoritative for process identity, replay, viewport ownership, and
  session lifetime.

## Considered Options

- **Option A**: Keep the native AgentPanel plus `PtyTerminalWebView` split from ADR-0056.
- **Option B**: Render xterm in AgentPanel and add Swift messages for every PTY operation.
- **Option C**: Render xterm in AgentPanel and expose a sidecar terminal resource through the existing
  authenticated Agent HTTP relay.

## Decision Outcome

Chose **Option C**. AgentPanel dynamically loads the checked-in xterm.js package and owns the bottom
pane, input encoding, output replay, viewport measurement, focus, theme, and resize interaction. The
pane is structurally inside the main column rather than positioned by a platform overlay.

The panel sends only normalized session context and terminal data to bounded HTTP resources. The
sidecar correlates the exact Claude or Codex session with the catalog, validates its canonical project
directory beneath the user's home, derives `agent-resume-<source>-<session-id>`, and constructs the
fixed resume argv. It then speaks the existing protobuf protocol directly to the local PTY manager.
Output and checkpoints stream as SSE; input, viewport changes, detach, and kill are POST operations.
The existing host relay attaches authentication, so its bearer token never enters the page.

The shared composer may use this terminal only after higher-fidelity delivery is unavailable. An
available native window composer wins, followed by Claude's detected CLI inbox. If either route is
known unavailable and this Agent Feed terminal is already open, the panel sends the prompt as one
bounded bracketed paste followed by Return. It neutralizes terminal escapes, preserves drafts while
switching transports, and never creates a terminal merely because the composer was focused.

Closing the pane detaches rather than killing. The PTY and agent process therefore follow ADR-0078:
they survive without a viewer until natural exit or an explicit kill, and a later pane receives a
fresh manager checkpoint. Workspace and standalone terminal surfaces remain on the shared
`PtyTerminalWebView`; this decision changes only the selected-session terminal inside AgentPanel.

### Consequences

- Good, because Agent Feed terminal UI and transport iteration is TypeScript/sidecar-only and live on
  every AgentPanel surface.
- Good, because one DOM layout keeps the terminal in the main column beside, not over, Sessions/Bots.
- Good, because validation and command construction stay outside untrusted WebKit content.
- Bad, because AgentPanel now owns a focused single-terminal xterm integration in addition to the
  richer shared Workspace/standalone terminal runtime.
- Neutral, because Swift still launches the sidecar and PTY manager, but it does not render, route, or
  restate Agent Feed terminal data.

### Confirmation

- AgentPanel tests prove the pane is inside the main column and no `agent-terminal-*` native message
  is sent.
- Sidecar route and service tests pin catalog validation, deterministic argv construction, SSE replay,
  input encoding, viewport updates, conflicts, and detach.
- AgentPanel tests pin native-window and CLI-inbox priority, draft handoff, and the already-open PTY
  fallback.
- TypeScript builds code-split xterm into the AgentPanel bundle, and the terminal flow has no Swift
  source dependency.

## Links

- `SPEC.md` Agent Panel Terminal Flow
- ADR-0056 Bottom Agent Panel terminal
- ADR-0068 Let the last active terminal viewer own the source grid size
- ADR-0078 A PTY session lives as long as its process
- ADR-0095 Relay the agent feed instead of restating it in Swift
- ADR-0096 Serve the dev panel over the tailnet TLS name
