---
status: accepted
date: 2026-10-23
---

# An arena lane may argue against the prompt instead of doing it

## Context and Problem Statement

The reader asked for a run where one session does what the prompt asks and another argues only
against the idea. Until now every lane of a run did the same thing with the same prompt, and the
only ways lanes differed were their harness and model (ADR-0141). Touches the wire's
`ArenaLaneStance` (on `ArenaLaneRequest` and `ArenaContestantSummary`),
`agent-feed/sidecar/src/arena/contestants/laneStance.ts`, `arenaDrive.ts`, both Claude drivers and
the opencode contestant, `arenaRequest.ts`, the store, the manager's brief, and the panel's new-run
form and lane labels.

## Decision Drivers

- One mechanism for both harnesses (Claude, opencode) and both modes (terminals, headless).
- The reader can see exactly what a lane was told.
- A lane that argues against the idea must not do the task anyway.
- It must not read the other lanes' work: what it argues against is the idea, not one attempt at it.

## Considered Options

- **A run mode** (`mode: "debate"`) that fixes one lane for and one against.
- **A stance per lane**, `for` or `against`, carried in the prompt the arena sends it.
- **A stance per lane carried in the harness's system prompt** (Claude's `--append-system-prompt`).

## Decision Outcome

Chose **a stance per lane, carried in the prompt**. A run mode was knocked out because a run's
`mode` already answers a different question (panes or headless), and an against lane works under
either one; per lane, any mix works and the manager can plan one through the same API it adds lanes
with. The system prompt was knocked out by the first driver: the opencode serve's send takes text
alone, so it would have meant two mechanisms.

An against lane is sent a note before the prompt on every round. It is told that other lanes are
doing the task and that it will not see their work, to make the strongest honest case against doing
it (costs, risks, cheaper alternatives, evidence from the repository), not to do the task or edit a
file, and to end with its strongest objection. The prompt runs to the end of the message with no
closing tag, so nothing in it can end the note early. The lane also runs without its editing tools:
Claude without `Edit`, `Write` and `NotebookEdit` (the same list the manager runs without), and
opencode with the session rule that denies `edit`. Its shell stays under the machine's own
permission mode, as every lane's does (ADR-0139), so it can test a claim.

### Consequences

- Good, because one function (`promptForStance`) decides what every lane is sent, and the note is
  in the lane's transcript where the reader and the manager can read it.
- Good, because a `for` lane is driven exactly as every lane was before, and a run stored before
  stances reads as all `for`.
- Bad, because the shell can still write a file. An against lane that does is not stopped; its
  diff and `filesWritten` say so, as they would for any lane.
- Bad, because a terminals Claude lane receives the multi-line note as a paste, which Claude marks
  as pasted content. It acted on it in the run that verified this, since the message was nothing but
  the paste, but that depends on how the harness treats pastes.
- Neutral, because "blind" is a statement about what the arena hands the lane, not a wall: lanes
  run unconfined (ADR-0139), and a reach into a rival's worktree is recorded as one, not refused.

### Confirmation

`laneStance.test.ts` pins the note and where the prompt goes; `arenaService.test.ts` and
`arenaService.terminals.test.ts` pin that an against lane is sent the note on every round, headless
and at the start line, and that a `for` lane is sent the prompt alone; the driver tests pin the
removed tools and the opencode rule. A request naming any other stance is refused with 400.

## More Information

- ADR-0139: contestants run as plain agents and record what they reach outside their worktree.
- ADR-0141: the manager plans lanes through the arena's API; its brief now explains stances.
