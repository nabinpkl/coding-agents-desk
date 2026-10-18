---
status: accepted
date: 2026-10-18
---

# A Claude session resumes with the model, effort and permission mode it last ran with

## Context and Problem Statement

Every resume of a Claude session -- reopening a stopped one, switching it between the terminal and
the SDK runner, relaunching a stale runner (ADR-0144), reviving its pane, restarting it under a new
launch -- started it in the launch defaults (`configClaudeLaunch.ts`) and the CLI's default model
and effort. Only the run mode came back, from the transcript's last entrypoint (ADR-0143). A model,
effort or mode chosen for a session was lost the next time its process was replaced. t3code keeps a
thread's selection in its own store and launches with it every time. Touches
`transcripts/claude/claudeProjects.ts`, the catalog records, `terminal/session-panes/claudeSessionLaunch.ts`,
`claude-sdk/claudeSdkLaunch.ts`, and `terminal/session-panes/staleClaudeSessions.ts`.

## Decision Drivers

- What was chosen for a session stays the session's, whichever way it runs and however often it
  restarts.
- One authoritative home for the fact: a choice can be made from the panel, by Shift+Tab in the
  terminal, or with `/model` typed into it, and all of them must count.

## Considered Options

- **Read it from the transcript.** The CLI records the model (`requestedModel`) and effort on every
  reply and the permission mode on user and `permission-mode` records; the catalog's tail read takes
  the newest of each, beside the last entrypoint it already takes.
- **A sidecar store, as t3code keeps.** Written on every choice the panel makes.

## Decision Outcome

Chose **the transcript**. It is the CLI's own account, so it already holds a choice made any of the
three ways, where a store would hold only the panel's and drift from the rest. t3code needs a store
because the selection there is its own data; here it is the CLI's. A choice an SDK runner made that
no turn has recorded yet still wins (ADR-0144's launch choices), and every value is checked before it
reaches a command line.

### Consequences

- Good, because a session keeps its mode, model and effort through every resume, in both modes.
- Bad, because the model is pinned: a session resumes on the model it last ran, not on whatever the
  default becomes later.
- Neutral, because a launch default now only opens a new session. A changed default mode no longer
  reaches an existing session through a restart, so the stale-session check no longer counts a
  different `--permission-mode` value as behind the launch, and counts `--model` and `--effort` as
  the panel's own flags.
- Bad, because a mode above the launch default is not restored: bypass, under the default launch.
  The transcript is a file the session's own agent can write to as this user, so a mode read from
  it is capped at what a fresh launch would give; otherwise an agent could append a line claiming
  bypass and come back in it on its next resume. Its reader chooses the higher mode again from the
  chip. Model and effort grant no permission and are restored as read.

### Confirmation

`boundedSessionRead.test.ts` pins what the tail read takes (a subagent's reply excluded);
`claudeSessionLaunch.test.ts` pins `resumeSelection` and the terminal resume command;
`staleClaudeSessions.test.ts` pins the session-owned mode.

## Links

- ADR-0143 A Claude session can run through the Agent SDK, in a runner held by its tmux pane
- ADR-0144 An SDK session's runner is a pipe, and a stale one relaunches with resume when idle
