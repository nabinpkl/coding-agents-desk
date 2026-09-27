---
status: accepted
date: 2026-09-24
---

# Opencode sessions get the thread terminal Claude sessions have

## Context and Problem Statement

Claude and Codex threads offer a terminal below the composer (a shell in the session's directory)
and a tmux pane above the field (the session's own screen). Opencode threads offered neither: the
panel gated both on `isTerminalSource`, the capabilities advertised `canOpenTerminal: false`, and
the sidecar's terminal identity refused any other source. Readers of an opencode session had no
place to run the commands the thread was talking about.

## Decision Drivers

- The pane must never fork the transcript: opening a terminal beside a live session must not open
  a second client to it.
- One open joins rather than starts beside the first: a deterministic pane name per session id.
- Opencode serve ids are `ses_`-prefixed, not UUIDs, so the UUID check would refuse every one.

## Considered Options

- **Option A**: Resume the session's CLI in the pane (`opencode --session <id>`), mirroring
  `claude --resume`.
- **Option B**: Run plain `opencode` in the session's project directory and let the reader pick
  the session up in the TUI.
- **Option C**: No session pane, only the directory shell below the composer.

## Decision Outcome

Chose **Option B** because the serve owns opencode sessions and a resumed second client is
exactly what the session-tmux path exists to avoid; the pane runs the TUI where the work is and
the reader continues the session by hand. The directory shell below the composer comes along
unchanged (same `agent-session` kind every other source uses). Opencode lookup is stamp-only:
the serve keeps no process registry, so `liveTmuxSession` answers from the identity stamp the
pane carries, and a relabeled pane still rejoins by name.

### Consequences

- Good, because both terminal affordances key off capabilities and shared components, so no
  panel feature code was added: the same toggle, control, and pane Claude threads use.
- Good, because a second open joins the running pane by its `agentdesk-opencode-<id>` name
  instead of starting beside it.
- Bad, because the pane does not land on the session: the reader picks it in the TUI's own
  picker. A `--session` resume is the explicit follow-up, not this change.
- Neutral, because `liveTmuxSession` stays registry-driven for Claude and stamp-only for
  opencode; Codex keeps answering none.

### Confirmation

`agentTerminalSessionPane.test.ts` pins the pane name, the `["opencode"]` argv, the join path,
and the id refusal; `agentTerminalService.test.ts` pins the directory shell; `threadTerminal.test.tsx`
pins both panel contexts for an opencode thread.

## Links

- ADR-0108 (Agent Panel terminal flow)
- ADR-0116 (opencode sessions join the feed)
