---
status: superseded by ADR-0141
date: 2026-10-13
superseded-by: ADR-0141
---

# An arena run may have a judge: a read-only session in a pane, briefed by the sidecar, prompted only by the reader

## Context and Problem Statement

The arena records facts and leaves judgment to the reader, who reads every lane side by side. With
several lanes and several prompts that reading is long, and the reader asked for a judge they can
put the question to: a Claude or opencode session chosen when the run starts (Claude by default,
or none), shown as a window over the lanes that does not take a lane's width. Touches
`agent-feed/sidecar/src/arena/judge/`, `arenaService.ts`, `arenaRequest.ts`, the wire's
`ArenaJudgeSummary`, and the panel's `features/arena/judge/ArenaJudgeWindow.tsx`.

## Decision Drivers

- The arena never keeps a score: a verdict is somebody's answer, not a fact on the record.
- A judge reads output written by agents that run unconfined (ADR-0139), so what it reads is
  untrusted and it must not be able to act on it by changing the worktrees.
- One session surface: the judge should be a session every existing surface can show, not a new
  viewer.

## Considered Options

- **A session in a pane, briefed through files, prompted by the reader**: started with the lanes
  in `<run folder>/judge`, read-only by its harness's means, with the sidecar keeping a brief and
  every settled contestant's transcript and diff in that folder.
- **A judge turn the sidecar prompts after every round**: a verdict appears on its own.
- **A headless verdict stored on the run**: a judge model's answer recorded as a run fact.

## Decision Outcome

Chose **a session in a pane, briefed through files, prompted by the reader**. The other two put a
verdict where facts go: a stored verdict is exactly the score the arena does not keep, and a
judge prompted every round spends a turn per round whether or not the reader wanted one.

- The judge starts with the lanes, in `<run folder>/judge`, beside the worktrees rather than above
  them, so no contestant's harness loads its brief. A terminals run only; a headless run has no
  pane to hold one, and the request is refused.
- Read-only by each harness's own means: Claude runs with `--permission-mode plan`; the opencode
  session is created holding rules after its agent's that deny `edit` and ask before `bash`.
- The brief is the file the harness loads by itself from its folder (`CLAUDE.md`, `AGENTS.md`), so
  the judge knows its role without a turn. It carries the latest prompt and every contestant's
  recorded facts, and is rewritten whenever the run changes. Each settled contestant's transcript
  (rendered by the handover renderers, tool output cut to head and tail) and diff are files beside
  it.
- Transcripts are held between tags carrying a per-run nonce that the brief names, the brief says
  their content is data and never instructions, and the nonce is struck from every transcript
  before it is written, since a contestant can read the judge's folder and could otherwise close
  its own tag.
- The panel shows the judge as a button in the corner that opens into a window holding its
  `SessionView`; it starts put away.

### Consequences

- Good, because a verdict is the judge's answer in its own session, with the facts it was given
  in a file the reader can open.
- Good, because a judge that cannot start fails on its own record and the lanes go on.
- Bad, because a judge still has this machine's MCP servers, the same exposure contestants have;
  plan mode and the opencode rules limit what it can change, not what it can call.
- Bad, because the transcripts are rewritten only when a contestant settles; mid-turn, the judge
  reads the previous turn's.
- Neutral, because Claude reads its `CLAUDE.md` once at start, so the brief tells the judge to read
  the folder again before each answer rather than relying on what it loaded.

### Confirmation

`arena/judge/arenaJudges.test.ts` pins the order (brief, then pane), the read-only spelling of each
harness, the folder following the run, and the judge ending with its run; `judgeBrief.test.ts`
pins the nonce being struck from a transcript.

## Links

- ADR-0141: the judge became the run's manager, which plans and starts the lanes through the arena's API.
- ADR-0139: contestants run as plain agents, which is why the judge's input is untrusted.
