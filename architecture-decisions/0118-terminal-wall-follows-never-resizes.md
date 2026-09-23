---
status: accepted
date: 2026-09-23
---

# Terminal wall tiles follow the pane and never resize it

## Context and Problem Statement

A wall tile opened at its own remembered grid (60x30 default) and claimed the pane through
the ordinary viewport report. The sidecar's `adoptPaneSize` then ran `resize-window -x -y`
whenever no real tmux client was attached -- the usual state of an agent's pane -- reflowing
the live session in its owner's terminal to whatever box the tile held. A drag did the same
per settle. The client-count guard only protected panes somebody happened to be watching.

## Decision Drivers

- A viewer must never reflow the session it is viewing; tmux has one window size for all.
- A drag must still do something visible: a dead handle is a second bug.
- Sessions the panel itself owns (created cards, forks) keep their existing adopt path.

## Considered Options

- **Wall tiles send `claim: false` and resize locally**: the tile's own xterm takes the
  dragged grid, the pane is only ever read.
- **Remove the drag handles**: no local effect, nothing to misrender, but no reader control.
- **Delete the sidecar claim path entirely**: strongest guarantee, but reaches the owned
  sessions above in the same change.

## Decision Outcome

Chose **follow with local resize** because it bounds the blast radius to the wall: only
`TerminalTile` (used solely by the strip cards) passes `paneShape: "follow"`, so its
viewport reports carry `claim: false` and the sidecar only ever refreshes. The drag resizes
the tile's local terminal through the existing `resizeGrid` plumbing and persists per
session as before. The sidecar adopt path stays for panel-owned sessions.

### Consequences

- The tile re-snaps to the pane's shape on the pane's own moves (checkpoint), so a tile
  tracks live work and rests at its arranged size between moves.
- A locally resized tile can misrender absolutely-addressed TUIs until the next snap; the
  live session is never touched, which is the trade chosen.
- Drag and nudge start from the live grid (`measureGrid`), not the stored one, so a snap
  between visits never jumps the box.

### Files

- `packages/AgentPanel/Web/src/features/terminal/TerminalTile.tsx`
- `packages/AgentPanel/Web/src/features/terminal/useAgentTerminal.ts`
- `packages/AgentPanel/Web/src/features/terminal/mounted-terminal/agentTerminalTypes.ts`
- `packages/AgentPanel/Web/src/features/terminal/TerminalTile.test.tsx`

## Update 2026-09-23: the drag sizes the box, not a local grid

The local-grid half above was wrong and is removed in the same arc's follow-up: a tile
rendering the pane into a smaller grid baked wrap into xterm's buffer, where no scrollbar
can undo it. The tile grid now stays the pane's shape always; what the reader arranges is
the mount's box in CSS pixels (`tile-box` store), the fit scales the type to fill it, and
past the type floor the mount scrolls. The drag-request module this decision added
(`mounted-terminal/agentTerminalViewport.ts`) is deleted with it, and the hook's
`resizeGrid` goes with it -- its only caller was the tile drag.
