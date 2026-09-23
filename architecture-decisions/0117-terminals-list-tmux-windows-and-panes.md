---
status: accepted
date: 2026-09-23
---

# Terminals list windows and panes, addressed the way tmux addresses them

## Context and Problem Statement

The Terminals canvas listed one row per tmux session. A session with four windows (`harbor`)
showed one row with "4 windows" as metadata, and opening it landed on the active window --
the other three were unreachable from the panel. `TmuxSessionSummary` carried only the count.

## Decision Drivers

- A running window must be openable, not just countable: the canvas is a wall of live work.
- Targets must stay buildable from validated pieces: the panel is a browser tab and every
  tmux verb takes `-t` on an argument vector this process builds.
- Listing cost must stay flat: one refresh is three tmux round trips, not three per session.

## Considered Options

- **Window rows as `session:index` children**: a third nesting level (directory, session,
  window) with new open-key identities and stored-set migrations.
- **Session rows with nested window/pane rows, addressed `session:window.pane`**: the tmux
  target form as the open key suffix, no identity migration.
- **A window switcher inside the open tile**: no listing change, windows reachable only
  after opening the session.

## Decision Outcome

Chose **nested rows with tmux target addressing** because it makes every window visible
without moving any existing identity: session rows, child keys and kill behavior are
unchanged, and a window key is the session key plus the same `:window[.pane]` suffix tmux
itself takes. The switcher option lost on visibility -- the complaint was that windows
cannot be seen. Single-window sessions render nothing new (progressive disclosure), and
`list-windows -a` / `list-panes -a` fold into the existing sessions response in two queries.

### Consequences

- `TmuxSessionSummary.windowList` is required; fixtures constructing sessions name it.
- `TmuxTerminalContext.session` accepts `session:window[.pane]`; kill stays session-level.
- `parseTerminalChildKey` returns `{ session, window?, pane?, target }`; stored sets keep
  working, with window/pane keys pruned against the live listing like session keys.
- Separator lesson, measured: the sidecar runs locale-stripped and tmux in the C locale
  sanitizes control bytes in `-F` output to `_`, so the windows/panes queries split on `|`
  with free-form fields last, matching the sessions query.

### Files

- `agent-feed/wire/terminal.ts`, `agent-feed/wire/index.ts`
- `agent-feed/sidecar/src/terminal/tmux/tmuxSessionList.ts`
- `agent-feed/sidecar/src/terminal/agentTerminalIdentity.ts`
- `packages/AgentPanel/Web/src/features/terminal/canvas/TerminalWindowRows.tsx`
- `packages/AgentPanel/Web/src/features/terminal/canvas/strip/`
