---
status: accepted
date: 2026-10-12
---

# Arena runs drive their contestants as terminal sessions, beside the headless mode

Adds a second way of driving an arena run. ADR-0128's headless drivers (`claude --print`, the
opencode serve's API alone) and ADR-0130/0132's confinement stand unchanged.

## Context and Problem Statement

A headless contestant is a process the reader never sees until it has finished: no pane to
watch, nothing to answer if the harness asks something on its way up, and no way to step into
the session afterwards except by opening it somewhere else. Everything a reader needs to watch
a session work already exists for canvas sessions: a tmux pane started, stamped and named by
the sidecar, a composer readiness check (`awaitComposer`), a composer the panel types into
(`syncTmuxComposer`, then Enter), and a terminal component that joins a pane by name
(`AgentTerminalPane`). The arena had none of it.

## Decision Drivers

- Reuse the canvas's machinery rather than build a second session runner.
- Keep headless, so a machine with the CLIs and no tmux can still run an arena.
- The facts must mean the same thing whichever way a run was driven.

## Considered Options

1. Replace headless with terminals.
2. **A per-run mode: `terminals` beside `headless`.**

## Decision Outcome

Option 2.

- **`ArenaRunMode` is `terminals` or `headless`, chosen per run.** `GET /api/arena/modes`
  answers what a machine offers, default first: terminals and headless where `config.tmuxPath`
  is set, headless alone where it is not. A terminals run asked of a machine with no tmux is a
  400 naming why. A run saved before modes existed reads as headless.
- **Terminals drivers start ordinary sessions.**
  - **Claude:** `startClaudeSession` with the headless argv minus `--print`, plus `-n` with the
    contestant's label.
  - **Opencode:** the session is created on the serve holding its rules exactly as headless
    does, then `opencode --session <id>` runs in its own pane.
  - **Both:** the pane is stamped with the session id (`adoptTitleName`), so the lane's
    terminal, a canvas card and `tmux attach` all reach the same pane.
- **Ready is the harness's own signal.**
  - **Claude:** ready once `awaitComposer` sees its composer drawn, so a folder-trust question
    holds the contestant at `starting` until the reader answers it in the pane.
  - **Opencode:** waits for its TUI to draw and go quiet, at most 15s. That wait is for the
    reader's eye only: the prompt goes through the serve, which needs no TUI.
- **One start line per run (`StartLine`).** Each contestant either arrives (ready) or leaves
  (failed before it could), and the arrivals are prompted together once the last one has done
  either. A contestant's clock (`startedAt`) starts at the prompt, so load time and a reader
  answering a startup question are not part of the turn being compared.
- **Statuses gain `starting` (pane up, harness loading) and `ready` (waiting at the line).**
  Each contestant also carries `tmuxSession`.
- **Turns close from the harness's own record.**
  - **Claude:** a transcript write, heard through the catalog's corpus watch
    (`onTranscriptWrite`). The turn is closed once a user record opened it and the last
    boundary is `end_turn`, the same rule the catalog reads liveness by.
  - **Opencode:** the serve's idle marker, exactly as headless.
  - The facts are read the same way as headless, so their meaning does not depend on the mode.
- **Panes outlive their turns and end when the run is deleted**, before its worktrees are
  removed. A closed contestant's pane is still a session the reader may be reading or typing in.
- **The lane joins the pane with the canvas's own terminal**: typeable, as a band under the
  session's feed, and the whole lane before a Claude contestant's first turn puts it in the
  catalog.

## Consequences

- A reader can type into a contestant's pane at any time. Doing so before the turn closes is
  the reader's own act on the comparison, not something the arena records or prevents.
- A Claude turn the reader interrupts writes no `end_turn`, so it closes only by the run's
  timeout.
- Opencode's ready is a look, not a gate. A TUI that never settles costs the reader 15 seconds
  of watching it load, never the contestant's turn.

## Links

- ADR-0128: Claude contestants (headless).
- ADR-0130: confinement to the worktree and six tools.
- ADR-0132: the opencode client and typed create rules.
