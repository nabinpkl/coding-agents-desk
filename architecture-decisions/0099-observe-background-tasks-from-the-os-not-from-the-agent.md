---
status: proposed
date: 2026-08-14
---

# Observe an agent's background tasks from the OS, and stream their output on demand

## Context and Problem Statement

A Claude session can start a background shell and keep talking. That shell outlives the turn
that launched it -- measured across this machine's 119 transcripts, 990 paired background Bash
tasks ran p50 53s, p75 95s, p90 209s, with 31 over ten minutes and one at 79 minutes. For all
of that time the Agent Panel shows nothing: the session reads `ready`, the transcript's last
line is an ordinary assistant message, and the viewer cannot tell a finished session from one
waiting on a build.

Worse, the agent itself is a poor reporter. A well-behaved agent redirects a long command's
output to a file and reads only the tail at the end, precisely so it does not burn context on
300 lines of log. That is correct agent behavior and it leaves the human blind: Claude Desktop's
own background-tasks panel renders `No output yet` for exactly this shape, because it watches
the task's stdout capture file, which a redirect leaves empty. The viewer cannot distinguish a
process making progress from one wedged, nor an agent working from an agent blind-waiting.

This touches `agent-feed/sidecar/src/transcripts/`, a new detection module, the wire types in
`agent-feed/wire/`, and the Agent Panel shell in
`packages/AgentPanel/Web/src/app/AgentPanelApp.tsx`.

## Decision Drivers

- The signal must exist for sessions the panel can already see, which is transcript-backed
  sessions. `runState` (ADR-0095's live projection) needs the proxy observer and is hardcoded
  `"idle"` for everything else at `sessionRoutes.ts:125`.
- It must not require modifying the user's Claude configuration. Installing a hook into
  `~/.claude/settings.json` to observe a fact already on disk is a side effect on a tool we do
  not own.
- The panel is reachable from the phone over the tailnet. Anything it can stream is something
  a phone client can ask for.
- Cost is paid per panel refresh, against a catalog holding 1237 sessions across 51 projects.
- Correctness under kill: agents and users stop background tasks routinely.

## Considered Options

- **Option A**: Derive everything from the transcript JSONL the sidecar already tails.
- **Option B**: Install a `PostToolUse` hook to record task starts, and poll for completion.
- **Option C**: Derive identity from the transcript and state from OS + filesystem, joining the
  two on the harness's task id.

## Decision Outcome

Chose **Option C**.

Option A is disproved by measurement, not by taste. A killed task emits **no** completion
record: in the live smoke, two of a session's four finished tasks were `[killed]` and the
transcript still described them as running, permanently. Transcript-only over-reports in-flight
work and never self-corrects.

Option B fails the second driver outright -- it writes into the user's settings to learn a fact
already legible on disk -- and it does not even close the gap: the current hook surface
(code.claude.com/docs/en/hooks, read 2026-08-14) has no event that fires when a background Bash
task **completes**. `PostToolUse` fires when the task is *launched*. `TaskCreated`/`TaskCompleted`
are the `TaskCreate` todo tool, not shells. So Option B buys an earlier start edge, which we do
not need, at the cost of a config mutation, and still leaves completion to polling.

Option C uses each source where it is authoritative:

| fact | source | why this one |
| --- | --- | --- |
| session ↔ owning process | `~/.claude/sessions/<pid>.json` | the harness maintains it; carries `procStart` specifically to defeat PID reuse |
| which tasks are running | `lsof` the writable descriptors of the session's child shells | a task shell holds `…/tasks/<task-id>.output` open for writing, so the process↔task join is exact and needs no command-string matching |
| terminal state | trailing `[exited with code N]` / `[killed]` in the `.output` file | written by the harness, present for killed tasks, immediate |
| description, command | the transcript's `tool_use.input` | the only human-readable source |
| live output | the fds the task itself holds open | survives redirection, which the `.output` file does not |

The two state sources fail in opposite directions and are therefore kept together: the
`.output` marker is authoritative but ephemeral (`/private/tmp` reaping removed an earlier
session's task directory entirely), while the transcript notification is durable but absent for
killed tasks. Either alone is wrong somewhere.

### The security boundary

**The streamed file is discovered from the task's own open file descriptors. It is never a path
supplied by the caller.** The sidecar is reachable from the phone; an endpoint taking a path
parameter would be a filesystem read oracle over everything the sidecar process can reach.
Restricting the stream to fd-derived targets yields exactly what the task is writing, which is
all the feature ever needed.

### What this deliberately does not do

**No "stuck" verdict.** A quiet `xcodebuild` writes nothing for minutes and then bursts;
classifying that as stuck would be wrong more often than right. The panel reports the raw pair
-- bytes/sec and time since last growth, alongside process liveness -- and lets the reader
judge. The question "is the agent blind-waiting?" is answered by whether any number is moving,
not by a classifier.

**No new meaning for `runState`.** `runState` is set from the Anthropic SSE stream --
`message_start` → `running`, `message_stop` → `idle`
(`claudeLiveBackend.ts:478`, `:546`) -- and means "the model is generating tokens". It goes idle
the instant a turn ends, while the task that turn launched runs on for minutes. Both facts are
true simultaneously and they are different facts, so background tasks get their own field. A
session also has several tasks at once, so that field is a list, not an enum.

### Consequences

- Good, because the signal covers every transcript-backed session, including ones with no live
  network observer, and works cross-session: the smoke found another session's in-flight task
  from this repo's session.
- Good, because live output works for the redirected case that Claude Desktop reports as
  `No output yet` -- the smoke streamed 550 lines of a task whose stdout capture was 0 bytes.
- Bad, because it depends on three undocumented harness artifacts: the `sessions/<pid>.json`
  registry, the `<session>/tasks/<task-id>.output` path, and the terminal-marker text. A Claude
  Code release may move any of them. This is the same class of exposure as `SpacesProvider`'s
  private-API binding, and it is accepted for the same reason: the fact is not available any
  other way. Mitigated by a smoke that fails loudly rather than reporting an empty task list.
- Bad, because `lsof` is a fork per poll: 128 ms across four live sessions. Gated to sessions
  with an unresolved task start, and cached per task once the target resolves.
- Neutral, because the transcript scan cannot use the bounded-tail trick ADR-0097 established.
  A 512 KB tail of a 29 MB transcript yields 15 lines -- individual lines are large -- so
  resolving a task's description needs a 1 MB backward window (4 ms) and up to 4 MB (21 ms) for
  one started hours ago. Affordable only because it runs for sessions whose process is alive,
  which is a handful, not the catalog's 1237.

### Confirmation

A read-only smoke, runnable against any live Claude session, that prints in-flight tasks with
elapsed time and follows one task's real output. Its acceptance signal is parity with the
harness's own panel: for the session used to develop this, `Running 1 / Finished 4`, matching
Claude Desktop exactly. When a harness release breaks one of the three artifacts above, the
smoke fails rather than silently reporting nothing in flight.

**Corrected 2026-08-17.** That parity check passed on a session whose tasks all happened to be
plain commands, and it hid a fourth assumption nobody had written down: that the capture sits on
**fd 1**. It does not when the agent's own command redirects or pipes its top-level stdout --
`{ … } > results/bakeoff.log 2>&1` -- because zsh then puts the log on fd 1 and moves the capture
to a saved descriptor (measured: fds 12 and 14). Those tasks were invisible to the probe, and
since a running task holds no terminal marker, the panel showed them as finished with an unknown
outcome, permanently. The join is now the descriptor's **name and write access**, on any
descriptor number, and the measured descriptor table is a unit test -- the smoke cannot assert
this one, since it only sees the shapes that happen to be running. The general lesson for the
three artifacts above stands and gains a fourth: a parity check against one session proves the
shapes that session happened to contain, and the failure is always the silent direction.

## Pros and Cons of the Options

### Option A -- transcript only

- Good, because it needs no new mechanism and rides the tail the sidecar already runs.
- Good, because it is durable: the record survives `/private/tmp` reaping.
- Bad, because killed tasks never emit a completion record, so in-flight counts inflate
  permanently. Measured: 2 of 4.
- Bad, because it carries no output at all when the command redirects, which is the case the
  feature exists for.

### Option B -- install a hook

- Good, because `PostToolUse` gives a lower-latency start edge than tailing a file.
- Bad, because it mutates configuration for a tool we do not own, to learn a fact already on disk.
- Bad, because no hook event fires on background-task completion, so it does not remove polling.

### Option C -- OS state joined to transcript identity

- Good, because each fact comes from where it is authoritative, and the two state sources cover
  each other's failure mode.
- Good, because the fd join is exact rather than heuristic.
- Bad, because it depends on undocumented harness layout, and costs a `lsof` fork per poll.

## Links

- ADR-0075 -- projects screen must not read transcript bodies
- ADR-0095 -- relay the agent feed instead of restating it in Swift
- ADR-0097 -- list sessions from the index (bounded reads; this ADR records where that trick
  does not transfer)
- Claude Code hook reference, read 2026-08-14: https://code.claude.com/docs/en/hooks
