---
status: accepted
date: 2026-10-11
supersedes: ADR-0127
---

# The arena tab reads contestants side by side in lanes, each lane the existing SessionView

Supersedes one consequence of ADR-0127 and nothing else: "the arena does not stream a
contestant's transcript into its tab: sessions are read where sessions are already read."
Everything else ADR-0127 and ADR-0128 decided stands.

## Context and Problem Statement

The first Arena tab was a form, a list of runs, and one card of facts per contestant. To compare
how contestants worked rather than only what they left, a reader had to leave the tab and open
each session somewhere else, one at a time. That is the comparison the tab exists for, done
nowhere side by side.

## Decision Drivers

- A comparison is read across: the same fact for every contestant on one line.
- One contestant should read as one column: its facts directly over its own session, so a number
  is never matched to a transcript in a different table.
- No second transcript reader. The panel already has one, and it already renders as a narrow
  column on a canvas card.

## Decision Outcome

- A run is laid out as lanes, one per contestant, in one grid that scrolls sideways as a whole.
  The top of each lane is its facts, with every lane carrying the same rows at the same fixed
  height so they read across. Under the facts sits one of three views behind one fixed switch:
  the contestant's session, the diff it left, or (across lanes) the matrix of files touched by
  repository-relative path.
- The session in a lane is `SessionView`, the component canvas cards render, mounted with a
  context the tab builds from its own machine's data source. Lanes find their sessions in the
  catalog by session id, asking the inventory for the run's worktree directories and its
  repository.
- The arena still judges nothing. The facts are aligned and durations share one scale. No lane is
  marked best.

## Consequences

- A run of N lanes opens N sessions' streams at once. That is only workable on the HTTP/2 dev
  origin AGENTS.md describes; a plain-HTTP origin's connection cap starves a lane. Verification
  of the tab runs against a TLS origin for that reason (`chrome-test/arena-verify.mjs`).
- Each lane's composer is live, so a reader can steer one contestant mid-duel. That changes what
  the run's facts measure for that contestant, and the arena does not record it. The reader made
  the choice in front of the lane.
- Layout is swept by `chrome-test/arena.sweep.mjs` (taste:frontend-layout-sweep), with the
  shell's own tab bar left out so the sweep's switcher pass cannot reach the machine shell.
