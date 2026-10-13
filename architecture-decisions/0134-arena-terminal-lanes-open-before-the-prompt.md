---
status: accepted
date: 2026-10-13
---

# A terminals arena run opens its lanes before it has a prompt

Extends ADR-0133. Its drivers, statuses, confinement and fact derivation stand unchanged.

## Context and Problem Statement

ADR-0133 made each terminals contestant an ordinary session in its own pane, with the prompt
typed once every lane was ready. The prompt still had to be written before anything started, so
a reader composed it blind: no harness was up, there was nothing to answer, and no lane to look
at. The owner asked for the lanes to be open and ready first, each with its empty activity feed
and its terminal, so the prompt is typed into lanes they can already see.

## Decision Outcome

- **A terminals run may be created with an empty prompt.** That opens its lanes: worktrees,
  sessions and panes, with each contestant coming up to `ready` exactly as before. A headless
  run is still refused without a prompt, because it has no lanes to open first.
- **The start line opens on two conditions**: every contestant has arrived or left, and the run
  has its prompt. `ready()` resolves with the prompt, which is what the drivers send; the plan's
  own prompt is empty for a run whose lanes opened first.
- **`POST /api/arena/runs/:id/prompt` gives the prompt**, once, to a run that is waiting for
  one. It may come before every lane is ready, in which case it waits at the same line.
- **A run still waiting for its prompt can be removed.** Removing it aborts the start line, so
  every contestant waiting there fails. It also ends the panes, so a contestant still on its way
  up sees its harness gone and fails too. The removal waits for every drive to settle before
  removing the worktrees. A run that has its prompt is refused while live, as before.
- **The panel opens lanes from the New Run form** ("Open lanes" when Terminals is chosen and the
  prompt is empty). The run's header holds the prompt box until the prompt is sent. A Claude lane
  shows the same empty feed an opencode lane does until its first turn puts it in the catalog.

## Consequences

- The start line lives in the sidecar process. A run whose lanes are open when the sidecar
  restarts has its contestants marked failed, as any live run does, and can no longer take a
  prompt.
- A run's `prompt` is empty until it is sent, so every surface that shows it must handle an
  empty one. The rail reads "Waiting for a prompt".
