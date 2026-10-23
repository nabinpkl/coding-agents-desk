---
status: accepted
date: 2026-10-23
amends:
  - ADR-0151 an against lane never sees another lane's work
---

# An arena pass sends one lane's answer to a lane on the other side

## Context and Problem Statement

ADR-0151 let a lane argue against the prompt, blind to the other lanes. The reader asked for the
next step: pass the for lane's answer to the against lane, which critiques that design as a
pessimist (what it misses, why it will not work), and pass the critique back to the for lane to
weigh. They asked for the notes around a pass to guide each model's judgment rather than hold it to
a list of rules. Touches `arenaTurns.ts` (`lastAnswer`, `passLanes`), `contestants/laneStance.ts`
(`passText`, and the against note), `arenaDrive.ts`, `arenaService.ts` (`passAnswer`), the
`/api/arena/runs/:id/pass` route, the wire's `ArenaPassRequest` and `ArenaContestantDetail.answer`,
the manager's brief, and the panel's `run/ArenaPassButtons.tsx`.

## Decision Drivers

- The receiving lane gets the other lane's actual answer, whole, not a summary of it.
- A pass is a lane's next turn in the session it has, like a later prompt, in both modes.
- The passed text is another model's output: data to judge, never instructions.
- The notes leave the judgment with the model.

## Considered Options

- **Pass the answer as text in the receiving lane's next turn**, wrapped in a note naming whose
  answer it is.
- **Point the receiving lane at the other lane's transcript or worktree** and let it read.
- **Make passing automatic**: every round, each side is sent the other's last answer (a debate).

## Decision Outcome

Chose **the answer as text in a turn, on the reader's say**. Pointing at a transcript leaves the
lane to find the answer in a file full of tool calls; the worktree is named in the note as well, for
a lane that wants the files. An automatic debate takes the decision of when a critique is worth
answering away from the reader; it can be built on this later.

A lane's answer is read off the events its turn returns, when the turn closes: what it said after
its last tool call, or everything it said in the turn when it said nothing after one. It is kept on
the lane's record. A pass checks that the two lanes take different stances, that every lane has
settled (as for a prompt), and that the lane passed from has an answer. It then drives only the
lane passed to, in its session, with `passText`: a note, then the answer as written, to the end of
the message. The run's prompt and round do not move. An against lane is told to take the answer as
a proposal to test and stay the pessimist, a grounded one. A for lane is told to weigh the critique
on its merits: which points hold, change where one does, no obligation to agree. Both notes say the
judgment is the lane's and the text is guidance. The against note now says the lane sees other
lanes' work only when the reader passes it.

### Consequences

- Good, because a for-and-against exchange runs as many rounds as the reader wants, from the lane
  heads or through the API the manager calls.
- Good, because each pass has a request id of its own, so the opencode serve, which refuses a
  reused id, takes a second pass in the same round.
- Bad, because an answer is passed verbatim, including whatever framing the machine's own setup
  makes a lane end with (status blocks, suggestions). The receiving lane reads past it.
- Bad, because a pass longer than a prompt may be (16,000 characters with its note) is refused, not
  cut.
- Neutral, because a sidecar that restarts in the moment between a pass's start line letting its
  lane go and the text reaching the pane picks the lane up on the run's prompt instead.

### Confirmation

`arenaTurns.test.ts` pins how an answer is read and when a pass may go; `laneStance.test.ts` pins
both notes; `arenaService.pass.test.ts` runs a pass each way in both modes and checks nothing else
moves; `ArenaSurface.test.tsx` pins the lane head's button.

## More Information

- ADR-0151: lanes take a stance, carried in the prompt.
- ADR-0141: the manager drives the run through the same API, the pass included.
