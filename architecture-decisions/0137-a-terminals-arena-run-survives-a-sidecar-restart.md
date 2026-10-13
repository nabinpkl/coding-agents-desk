---
status: accepted
date: 2026-10-13
---

# A terminals arena run survives a sidecar restart

Supersedes ADR-0127's "contestants a restart orphaned are marked failed" and ADR-0134's
"a run waiting for its prompt when the sidecar restarts has its contestants marked failed", for
terminals runs. Headless runs keep that rule.

## Context and Problem Statement

A sidecar restart failed every unfinished contestant with "the sidecar restarted before this
contestant closed". For a terminals run that was not true of anything but the sidecar: each
contestant's harness runs in a tmux pane that outlives the sidecar, and its record already holds
the pane and the session id. The sidecar restarts whenever its own source changes, so on a
machine where the sidecar is being worked on, open lanes died within minutes.

## Decision Outcome

- **On start, the sidecar picks back up every unfinished contestant it can** (`afterRestart`,
  then `resumeInterruptedRuns`):
  - **Pane and session on the record, not yet let go** (`starting`, `ready`): nothing is started
    again. It waits for its existing pane to take a prompt, as on the first start, and goes back
    to a start line rebuilt for the run, which still takes the prompt of a run that had none.
  - **Already let go** (`running`): its turn is watched to the close and its clock is kept. It is
    sent its prompt only when the harness shows none: no opened turn in the Claude transcript, no
    user message in the opencode session. So no turn is prompted twice.
  - **No pane yet** (`preparing`): started over.
- **Failed, saying why,** when it cannot be picked up: a headless contestant (driven from inside
  the old process), a sidecar that came back without tmux, or a record with no pane. A pane the
  reader closed, or a harness that exited, fails the same way it does on a first start.

## Consequences

- A turn that closed while the sidecar was down is found closed on the first read, and its facts
  are read as usual.
- A headless run is still cut off by a restart. Its opencode turns live on the serve and could be
  watched the same way; that is not done here.

## Links

- ADR-0127, ADR-0133, ADR-0134.
