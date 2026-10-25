# Group chat

> Living design, opened 2026-10-25. Nothing here is built. Read against the code: every path and
> rule below was true on the day it was written.

## How to read this document

This document is meant to change, and then to go out of date.

- **Until the first slice ships**, it is the place the design is argued out. Edit it in place: change
  a decision, strike an option, move an open question into a decision. Add a line to the change log
  at the bottom so a reader can see what moved and when.
- **Once a part settles**, it moves out. A decision that locks something in becomes an ADR, which is
  frozen. A behaviour becomes code and its tests. This document then keeps only the reasoning and a
  pointer.
- **After that it will drift**, and that is expected. No one keeps a design document in step with
  the code it led to. Read it for what was decided and why, and read the code for what is true now.
  When the two disagree, the code is right. A section that is badly wrong can be marked stale rather
  than rewritten.

## What it is

A room where you and two to six agents (Claude or opencode lanes) talk. You post; an agent's reply
is its turn's answer; @mentions say who should speak next.

It lives in a new tab of its own, **Group**, not in the arena (decided 2026-10-25). The arena sends
one prompt to every lane and compares what each did; it is treated as the older design, and Group
does not build on its code, records or lanes, so none of its weaker choices carry over. Where an
idea is shared (lanes, a start line, reading a closed turn's answer), Group takes the idea and
writes its own.

What makes it different from a traditional group chat: a person in a group chat reads for free and
is always connected. An agent reads only by taking a turn, which costs money, rate limit and minutes,
and it takes one turn at a time. So the agent is closer to a worker with a mailbox than to a chat
client, and the design is a scheduling problem with a runaway to prevent: three agents replying to
each other grow without bound.

## Requirements

- **Functional:** you and the agents post; mentions route; the log survives a sidecar restart; you
  can stop a wave at any moment and it stops.
- **Scale:** one server (the sidecar), one human, two to six agents, tens of messages a wave.
  Messages per second do not matter.
- **The scarce resource is turns.** Capacity is counted in turns and tokens: three agents for three
  rounds is at most nine turns per message from you, about three to nine minutes when each round's
  turns run in parallel.

## Principles (decided)

1. **The supervisor owns the loop and the brakes; the agent owns what it says.** The supervisor calls
   an agent once per turn; an agent never starts work by calling the supervisor. The agent decides
   what it writes, whom it mentions, and whether it passes, is done, or asks you. Each of those is a
   request the supervisor checks, and **a signal from an agent can only make things stop sooner or
   cost less, never run longer.** Nothing an agent writes can raise a budget, close a breaker or
   extend a lease: those knobs are not in prompt space. Whatever reads untrusted text can be talked
   into things, so it must not hold the brake.
2. **A small core specified completely, and features above it left free** (the Simplex architecture:
   a simple verified safety controller beneath a complex unverified one). Rigor goes by how much
   damage a part can do, one part at a time (IEC 62304's classes work this way):

   | Class | What | How it is built |
   | --- | --- | --- |
   | C, the kernel | Leases, admission and budget, the group kill, breakers, recovery on restart | Specified completely before code (below). Tested against misbehaving fakes. Small on purpose. Changing it is a one-way door |
   | B, the protocol | The room log and its numbering, rounds, mention routing, coalescing | Interfaces fixed; behaviour behind them may change |
   | A, everything else | The panel view, the notes sent to agents, roles, modes, a moderator | Underspecified, grown in live use |

3. **An independent interlock under the smart layer.** Therac-25 removed the hardware interlocks its
   predecessor had and left safety to software, which had a race. Here the interlock is the
   operating system: a process group killed with SIGKILL, under any check written in TypeScript and
   under the harness's own permission checks.
4. **Explore the riskiest unknown first, cheaply.** The kernel's riskiest unknown is whether a lane's
   process tree really dies. The test that settles it (a fake that ignores SIGTERM and leaves a
   grandchild) is also the first thing to build.

## The kernel (class C)

Six invariants. Everything in the room is built on them; nothing above may weaken them.

1. **No lease, no turn.** Every turn runs under a lease written to disk before it starts: the room,
   the lane, a deadline, and what to kill (a process group id and its process's start time, or an
   opencode session id). The sidecar renews the lease while the turn makes progress. An expired
   lease is killed, not abandoned.
2. **The budget fails safe.** Only a message from you grants turns. Turns are counted at admission,
   before a turn starts. A missing or unreadable budget counts as zero.
3. **Stop means stop, at the operating system.**
   - A spawned harness gets a process group of its own. Stopping it is SIGTERM first, a short
     grace, then SIGKILL, then a check that nothing is left.
   - One group is not enough: Claude runs each Bash command in a process group of its own (the
     spike measured it), and macOS has no cgroups, so a grandchild that starts a session of its own
     escapes every group. A snapshot of the lane's descendants is taken before the kill, and the
     SIGKILL goes to every group and process in it, not only the harness's.
   - SIGTERM first is load-bearing twice over: on it, Claude cleaned up its own tree, the Bash
     tool's group and a session-escaped grandchild included, and flushed its spans, in about a
     second. SIGKILL alone did neither.
   - An opencode lane lives in the shared serve, which must never be started twice, so its process
     cannot be killed: its session is aborted (`OpencodeAgentBackend.abort`), then checked idle.
   - A terminals lane's pane is interrupted, then its session ended.
4. **Crash-only, and turns are never retried.** The log and the leases are on disk. A starting
   sidecar's only recovery is to kill what has expired and mark it failed, before it admits anything.
   A turn is never sent again on its own: delivery to an agent is at most once. A traditional chat
   retries until delivered; a paid turn must not.
5. **Breakers.** Two failures in a row open a lane's breaker, and it sits out the rest of the wave.
   Three failures in a wave stop the wave. Only you close a breaker again; no timer half-opens it.
6. **One kill switch.** Stop room is written to disk, checked before every admission, and kills every
   live lease. A config switch turns rooms off entirely, and it is off by default.

Least privilege in the first slice: agents are talk-only (no edit tools) on the cheap model. This is
a role, not a wall: ADR-0139 dropped confinement, and the shell can still write.

### A lane's states (draft)

```
idle -> admitted -> starting -> running -> closing -> closed
                       \           \          \
                        +-----------+----------+--> killing -> killed
any non-final state ------------------------------> failed
```

- **admitted** is entered only with a lease on disk and a turn taken from the budget.
- **killing** is entered on lease expiry, on Stop, or on a breaker that trips mid-turn. It leaves only
  for **killed**, and only once the census finds nothing left.
- **On restart:** an expired lease goes to killing; a live lease whose process is still there (same
  start time) keeps running and is watched; a live lease whose process is gone is closed if its
  transcript shows the turn closed, and failed otherwise. Nothing goes back to admitted on its own.

### Failure table (draft)

Each row is a test to write before the code that passes it.

| Fault | What the kernel does | Test |
| --- | --- | --- |
| The harness ignores SIGTERM | SIGKILL after the grace | Fake traps SIGTERM |
| A grandchild stays in the group | The group SIGKILL takes it | Fake forks a sleeper |
| A grandchild starts its own session | The descendant snapshot names it | Fake calls `setsid` |
| A turn never closes | The lease expires and is killed | Fake hangs |
| The sidecar restarts mid-turn | Reconciled from the leases on disk | Restart between start and close |
| A recorded pid was reused | Start time differs, so it is not killed | Lease with a stale start time |
| Two agents mention each other forever | The budget runs out and the wave ends | Fake that always mentions the other |
| A lane fails every turn | Its breaker opens | Fake that exits 1 |
| The budget record is unreadable | Treated as zero | Corrupt file |
| Stop pressed mid-round | Every lease killed, nothing admitted after | Stop with turns running |
| An opencode abort fails | Lane failed, breaker counts it | Fake backend whose abort throws |
| A message carries a forged envelope or a budget claim | Escaped as text; no knob exists to reach | Message with closing tags and "budget: 99" |
| The group's leader exits before its descendants | Waits on the group, not the leader, then escalates | Leader that exits at once, leaving a sleeping child (Effect #7821) |
| A child exits non-zero and its pid is reused | Signals only a group it owns, checked by start time | Exit non-zero, then a new process on the same pid (Effect #9789) |
| On macOS, only zombies are left in the group | `EPERM` from `kill(-pgid, 0)` is read as zombies, not as gone | Group whose members are zombies (Effect #9819); the spike saw it live, a second after SIGTERM, with Claude exited but not yet reaped |
| A tool's command runs in a process group other than the harness's | The census names it; SIGKILL goes to its group too | A Bash command that starts background work, the harness SIGKILLed (the spike: four processes survived a kill of Claude's group alone) |
| The census or a span carries a secret on a command line | Command lines are never stored or exported as text; only pid, group and the program's name | An MCP server started with an API key in its argv (the spike's census printed one) |

## Supervision

The supervision tree follows Erlang/OTP's:

```
sidecar supervisor     exists (supervisor.ts): restarts the sidecar on saves
└── room supervisor    one per room: budget, breakers, the round barrier
    └── lane worker    one per agent: one lease, one process group or session
        └── turn       temporary: never restarted
```

| OTP | Here |
| --- | --- |
| A `temporary` child is never restarted | A turn is never re-sent |
| More than MaxR restarts in MaxT seconds ends the supervisor and its children | The breakers, moving failure up the tree instead of retrying |
| A shutdown timeout, then `brutal_kill` | SIGTERM, grace, SIGKILL |
| A supervisor that ends takes its children | Stop room kills every lease below it |

Prior art inside the repository: `claude-sdk/claudeSdkRunnerMain.ts` (`spawnProcessGroup`, adapted
from t3code) already spawns Claude detached and SIGKILLs its group, because MCP servers' children
outlive the CLI. The stop primitive and the lease are Group's own, in a directory of its own; the
arena keeps its lanes as they are.

## The protocol (class B)

- **The room log** is the one source of truth: an append-only file in the room's own folder. Each message
  has an author (you or a lane), its text, the mentions read from it, and the next number in the
  room, assigned by the sidecar as its only writer. No wall clocks order it. Lane transcripts stay
  each session's own record.
- **Each agent has a cursor:** the last number delivered to it. Its next turn gets the messages after
  its cursor, not the whole log; its session already holds the rest.
- **An agent's message is its turn's answer,** read off the closed turn (the arena's passes do the
  same, ADR-0152; the idea, not the code). Mentions are read from the text by code. "Pass" is silence. Nothing has to be called
  to post, so there are no per-message permission prompts.
- **Rounds:** your message opens a wave. In round 1, every agent you addressed answers in parallel
  (a start line, as the arena's runs have). In each later round, only agents mentioned in the round
  before speak. The wave ends when nobody is mentioned, when an agent says done, or when the budget
  runs out.
- **Coalescing:** however many messages mention a busy agent, it gets them as one batch at its next
  turn, and speaks at most once a round. This is what bounds a wave to agents times rounds.
- **Trust:** another agent's words arrive wrapped and escaped, as input to weigh. The task comes
  from you, as on the messaging hub, where an agent's message carries none of the owner's authority.

## Telemetry

The sidecar already traces with Sentry's SDK, kept on this machine (`telemetry/`). A room adds:

```
room.wave            one per message from you: budget granted, how it ended
├── room.admit       event: budget left, breaker state, admitted or refused
├── room.round
│   └── lane.turn    invoke_agent: lane, harness, model, lease, tokens, cost, outcome
│       └── Claude's own spans, when allowed (below)
└── lane.kill        signals sent, how long each took, what the census found
```

Names follow OpenTelemetry's agent conventions where they fit (`invoke_agent`, `gen_ai.*`); those
are still marked Development. Claude Code reads a `TRACEPARENT` passed to `claude -p` and nests
its own spans (each model request, each tool) under it, with tracing turned on by its beta flag
(its monitoring docs, read 2026-10-25). Interactive sessions ignore an inbound one. Every event
it sends carries the account's identity (email, account id, organisation id) unless told
otherwise, so what reaches the archive is scrubbed first. Using that needs two things: a sidecar
route that takes OTLP into the same archive, and an amendment to AGENTS.md's rule that what a feature knows about a live session comes
from the transcripts or the HTTPS proxy "and from nothing else" (an open decision below).

## Seeing outside calls

| Layer | Sees | Limits |
| --- | --- | --- |
| Transcript facts (exists: `outsideReaches`) | Paths tool calls named | Only what a tool declares; a `curl` inside Bash is text |
| Claude's sandbox (Seatbelt and a proxy with an allowlist), per run via `--settings` | Every connection Bash and its children try; a refusal is a `claude_code.safety_event` | Shell commands only, not MCP servers or file tools; it confines, which ADR-0139 ruled out; `allowUnsandboxedCommands: false` or Claude may retry outside it |
| The whole harness under `sandbox-runtime` | Every connection the process tree makes | Not installed; headless Claude only, since the opencode serve is shared; allow-all with logging unverified |
| Process census (the kill needs it anyway) | Which programs ran under a lane | A sample: a short command can come and go between looks |
| Endpoint Security, Network Extension | Every exec, every flow | Root and Full Disk Access, or a signed system extension: out of scope |

The first slice takes the transcript facts and the census. The sandbox in a detect-and-report form
comes when there is a reason to see the network.

## Gaps in today's arena

Found while designing this; they are bugs whether or not a room is built. Recorded, not fixed here:
the arena is treated as the older design, and Group does not depend on its lanes. Whoever next
changes the arena should know them.

- A headless Claude lane's timeout sends SIGTERM to `claude` alone, with no SIGKILL after, and leaves
  whatever it started (`arena/contestants/claudeContestant.ts`, the timer in `runClaudeContestant`).
- An opencode lane's timeout marks it failed and never aborts the session, though the backend can
  (`arena/contestants/opencodeContestant.ts`).
- A terminals lane's timeout marks it failed and leaves the pane running
  (`arena/contestants/terminalContestants.ts`).

So a timeout today stops the arena waiting, not the lane spending.

## The first slice

The smallest end-to-end room that is kept and grown (a walking skeleton). It is built after the
spike in "Unknowns the spike answers first" below, from this document rather than from the spike's
code.

- In: the room log, one route to post, one stream to read, rounds with mention routing, the six
  invariants, headless Claude only (a process exit is a clean close and a process group a clean
  kill), and a bare panel view: the log, a composer, the budget left, and Stop.
- Order:
  1. The stop primitive, against the misbehaving fakes in the failure table.
  2. Leases, budget and breakers, against a fake agent: the runaway test costs no tokens.
  3. The room log and the scheduler, still on fakes.
  4. One smoke run: two cheap-model lanes, a budget of two rounds, a two-minute lease.
- Property tests that throw random crashes, timeouts, stops and restarts at the lane's state machine
  stand in for a formal model; the state space is small enough.

Later, as two-way doors: opencode and terminals lanes once their stop is fixed, editing and
worktrees, one-at-a-time rotation, a Claude moderator whose API calls go through the same admission,
convergence detection, token budgets, a `PreToolUse` hook capping tool calls within one turn.

## Unknowns the spike answers first

Before the first slice, a spike: a throwaway script in a temporary folder outside the repository, a
few cents of cheap-model turns. It is left where it is once it has answered, never committed and
never deleted by hand (the temporary folder goes in its own time). What it hands on is findings,
not code: answers below, new rows for the failure table, decisions settled in this document. Code
written to explore
is never extended into the product: agents extending their own earlier code degrade it steadily
(SlopCodeBench, 2026), so the product is built fresh from this document and its tests.

The spike's shape: a small local receiver for spans, one `claude -p` lane given a `TRACEPARENT` and
asked to start a background process, killed mid-turn with SIGTERM then SIGKILL; then a list of the
spans that arrived and were lost, and a census of what survived. Its first traces are read by
hand for the first failure in each, before anything is automated.

| | Unknown | Why it matters | How it is answered |
| --- | --- | --- | --- |
| U1 | Does a killed lane lose its last spans? Claude batches them and exports every 5 seconds by default | The runaway we kill is the trace we most want; the grace before SIGKILL may have to cover a flush, or the interval be shorter | The spike's kill, spans counted before and after |
| U2 | What a real headless turn's trace holds with the default redaction (tool names, the first word of a Bash command, timings, tokens; not full commands, paths or prompt text) | Whether the detail switches (`OTEL_LOG_TOOL_DETAILS` and others) are needed, and acceptable | The spike's spans, read |
| U3 | Can a terminals lane's spans be matched by session id? Interactive Claude ignores an inbound `TRACEPARENT` | Otherwise those lanes get only the room's own spans | A traced interactive session, its attributes read |
| U4 | Can opencode's spans be tied to one session? Its v2 exports traces over OTLP when an endpoint is set, but the serve is shared, so one exporter config covers every session | Whether opencode lanes can be traced per lane at all | Restarting the one serve with an endpoint set, at a moment the reader chooses; never a second serve |
| U5 | Does a real `claude -p` leave survivors after a group SIGKILL: MCP servers, their children, anything that started its own session? | The kernel's interlock; the only measurement so far is a comment in `claudeSdkRunnerMain.ts` that MCP children outlive the CLI | The spike's census |
| U6 | Does Effect's process spawner behave on Bun? Its Bun spawner re-exports the Node one, so it runs on Bun's `node:child_process` compatibility | Decides whether options A and C below can use Effect's process handling at all | The kill test run on Effect's spawner on Bun |
| U7 | Can Effect's OpenTelemetry spans reach the sidecar's Sentry archive? | Otherwise A and C mean a second tracing stack | One span from Effect, looked for in the archive |

### What the spike found (2026-10-25)

Three turns of `claude -p` on Haiku (Claude Code 2.1.310), each given a `TRACEPARENT` and exporting
OTLP/JSON to a local receiver: one that finished, one sent SIGTERM mid-tool-call (5 seconds' grace,
then SIGKILL), one sent SIGKILL at once. The tool call ran a script that left a background sleep, a
`nohup` sleep and a sleep in a session of its own, then slept in the foreground. Every process the
spike started was stopped afterwards.

- **U1, spans on kill: answered.** A finished turn exported everything before it exited. On SIGTERM,
  Claude exited in about a second (code 143) and flushed: the `interaction` span arrived, but the
  Bash tool span still running when it was signalled never did. On SIGKILL, the `interaction` span
  never arrived either: only spans that ended before the last five-second batch, left without
  their parent. So Claude's spans cannot say how a killed turn ended; the room's own `lane.turn`
  and `lane.kill` spans must, and SIGTERM comes first.
- **U2, what a trace holds: answered.** The `interaction` span is `invoke_agent`, a child of the
  span we passed in, with the prompt redacted. Model requests carry the model, tokens, cache reads,
  time to first token, stop reason and request id. Tools carry the tool's name, and for Bash its
  first word and a class (`sh`, `lang_runtime`), not the command. Every span and event carries
  `session.id`, the id the lane was started with. A refused tool call is a `tool_decision` event and a
  `safety_event` (in the clean turn, a `Read` refused by the working-directory rule). Default
  redaction is enough for the room; the detail switches are not needed yet.
- **U5, survivors: answered, and it moved the kernel.** Claude's MCP servers share its group and die
  with it. Its Bash tool does not: each command ran under a shell in a process group of its own. A
  SIGKILL of Claude's group left all four sleeps running, three in the Bash tool's group and one in
  its own session. On SIGTERM, Claude cleaned up all of them itself. Invariant 3 and the failure
  table now say so.
- **U3, terminals lanes: answered.** An interactive Claude in tmux (Haiku, no tools, tracing on, a
  `TRACEPARENT` set) ignored the parent: its `interaction` span was a root (`parent.source` none)
  in a trace of its own. Every span and event, 41 of 41, carried `session.id`, the id the session was
  started with, and each prompt opened a new trace whose `interaction.sequence` counted 1, then 2.
  So a terminals lane's turn is found by its session id and that sequence number, and Group links
  it to its own `lane.turn` span on arrival rather than nesting it.
- **U6, Effect's spawner on Bun: answered.** `effect` and `@effect/platform-bun` 4.0.6 on Bun 1.3.13,
  each case a shell script that misbehaves one way, stopped through Effect with a 2-second
  `forceKillAfter`, then checked against the process table:

  | Case | Result |
  | --- | --- |
  | Leader and its child both ignore SIGTERM | Escalated to SIGKILL after 2 seconds; group empty |
  | Leader dies at once, a child ignoring SIGTERM outlives it (Effect #7821) | Waited on the group, not the leader; the child was killed after 2 seconds |
  | A child in a process group of its own, as Claude's Bash tool runs commands | Survived |
  | A grandchild in a session of its own | Survived |
  | No kill call: the scope is interrupted by a timeout | Release stopped the group, escalating after about 2.25 seconds |
  | Output | Streamed as written, lines about 300 ms apart, before the exit |

  So it does what its documentation says on Bun: everything inside its group, correctly, and
  nothing outside it. The census and the start-time check stay ours whichever option is chosen. A
  supervisor must always pass `forceKillAfter`: without it, its documentation says, termination
  waits for a process that ignores SIGTERM with no time limit.
- **Still open:** U4 (opencode) and U7 (Effect's spans into the archive).

## How the kernel is built: three options

The sidecar runs on Bun with Promise-based code. Effect (a TypeScript library for structured
concurrency) fits the shape of this work: processes tied to scopes, interruption that runs every
child's cleanup, timeouts, retries, and spans that follow the work's structure. Its core runs on any
runtime; processes, files and HTTP come from platform packages (node, bun, deno, browser).

| | A. An Effect island | B. Plain TypeScript | C. Effect's structure, our own spawner |
| --- | --- | --- | --- |
| Supervision | Scopes and fibers: Stop interrupts the room's scope and every child's cleanup runs | The lane state machine, written by hand | Scopes and fibers, as A |
| Kill and wait | Effect's `ChildProcess` (detached group, `forceKillAfter`, then SIGKILL, then a wait on the group), plus our census and start-time check, which it does not do | Our own, about 300 lines, with Effect's three bugs as failure-table rows | Our spawner behind Effect's `ChildProcessSpawner` interface, census and start-time check included |
| Spans | `withSpan` and `@effect/opentelemetry`, bridged to the archive (U7) | The Sentry spans the sidecar already makes | As A |
| Precedent | t3code, on Node with Effect's Node spawner | The sidecar's own `claudeSdkRunnerMain.ts` | OpenCode v2: Bun, Effect's interfaces, and its own 556-line `cross-spawn-spawner.ts` |
| Risk | The interlock rests on a module Effect marks unstable, with three process-group bugs fixed in September and October 2026; two concurrency models meet at a Promise boundary that interruption does not cross | More code of our own, and a class of structured-concurrency bugs to avoid by hand | Effect still spreads through every caller; the kill stays ours to get right |

Common to all three: Effect's three bugs are rows in the failure table above, whichever is chosen.
Costs of Effect in general: it spreads to every caller, people report two to eight weeks to become
productive, and v4 renamed modules that models know by their v3 names.

The lean so far is B or C: the Simplex principle says the part that guarantees the envelope should
be small and auditable, which argues for kill code we own. C keeps that while taking Effect's
supervision, and OpenCode shows it working on Bun. U6 is settled: Effect's spawner behaves on Bun,
so A and C are both open, and either way the census is ours. U7 is left before choosing.

## Libraries and runtimes considered

- **AutoGen and its kind: their vocabulary, not their code.** AutoGen has been in maintenance mode
  since 2025-10-02; its successor, Microsoft Agent Framework 1.0 (April 2026), is Python and .NET.
  More basic than the language: these frameworks treat an agent as a model call with tools and run
  the loop themselves, while a lane here is a whole harness with its own tool loop, permissions and
  transcript. A framework would own the cheap part (who speaks next) and none of the hard part
  (drivers, leases, the kill). Taken: composable termination conditions, a speaker-selection
  function, a group chat manager. A framework would fit a later mode whose agents are plain model
  calls, which a room is not.
- **Erlang: the pattern, not the runtime.** The BEAM supervises its own processes, not the
  operating system's; an OS process runs behind a port, and orphaned OS children are a known BEAM
  problem that libraries solve with a C helper (erlexec, which kills process groups and lists
  macOS) or Linux cgroups (MuonTrap). Our hardest problem would move into that helper, not go away,
  and it would add a third runtime beside Bun and the Python speech process. Taken: temporary
  children never restarted, restart intensity as the breaker, shutdown then `brutal_kill`, a
  supervisor that takes its children with it.

## Open decisions

- Whether agents touch code: talk only, a worktree each, or one shared tree.
- Who speaks after round 1: only agents mentioned (proposed), everyone each round, or one at a time.
- Defaults: rounds per wave (proposed 3), the lease (proposed the arena's 10 minutes, 2 for the smoke
  run), the grace before SIGKILL (proposed 5 seconds), and a hard maximum the reader cannot exceed.
- Whether Claude's own telemetry export may be a source, which amends an AGENTS.md rule.
- How the kernel is built: A, B or C above, after the spike answers U6 and U7.
- When to restart the opencode serve with a span endpoint, to answer U4.

## Prior art

- Omadia, open source: agent-to-agent discussion in Teams, shipped 2026-09-04. A turn budget that
  resets when a human speaks, one speaker at a time, silence and declared convergence as endings, a
  cap of 16 turns (40 at most), and a guard that stops when its cap cannot be read.
  https://github.com/byte5ai/omadia/issues/1018
- Grok Bot (xAI, launched 2026-08-11): two to six bots per group; bots decide among themselves who
  answers an unaddressed message (https://docs.x.ai/grok-bot/chat-and-collaboration). Its help on
  Cursor's site says there is no switch to stop bots messaging each other
  (https://cursor.com/help/grok-bot/group-chats), and a third-party review reports loops.
- ChatGPT group chats (OpenAI, piloted 2025-11-14): the model decides when to respond; naming it
  forces a reply. https://openai.com/index/group-chats-in-chatgpt/
- AutoGen: composable termination conditions, a message cap "to avoid infinite loop".
  https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html
- SillyTavern group chats: pooled order, so everyone speaks once before anyone twice.
  https://docs.sillytavern.app/usage/core-concepts/groupchats/
- Erlang/OTP supervisors: restart strategies, restart intensity, shutdown then `brutal_kill`.
  https://www.erlang.org/doc/apps/stdlib/supervisor.md
- Simplex architecture (Lui Sha); Leveson and Turner on Therac-25 (IEEE Computer, July 1993); the
  pacemaker formal methods challenge (McMaster, 2007); Newcombe et al. on TLA+ at Amazon (2014).
- Anthropic, "Building effective agents" (2024-12-19): stopping conditions "such as a maximum number
  of iterations". https://www.anthropic.com/engineering/building-effective-agents
- Effect's process spawner and its process-group issues #7821 (2026-09-03), #9789 (2026-10-22) and
  #9819 (2026-10-23), each fixed within a day.
  https://github.com/Effect-TS/effect/blob/main/packages/platform/node-shared/src/NodeChildProcessSpawner.ts
- OpenCode v2's own spawner behind Effect's interface, on Bun.
  https://github.com/anomalyco/opencode/blob/HEAD/packages/util/src/cross-spawn-spawner.ts
- t3code, harness providers on Effect and Node. https://github.com/pingdotgg/t3code
- SlopCodeBench (NeurIPS 2026): agents extending their own code across changing requirements eroded
  it in about 80% of runs; asking for quality lowered the start, not the decline.
  https://arxiv.org/abs/2603.24755

## Change log

- 2026-10-25: opened from a design conversation: principles, the kernel, supervision, protocol,
  telemetry, outside calls, the first slice, the gaps found in today's arena.
- 2026-10-25: added the unknowns the spike answers first (U1 to U7), with the rule that its code is
  deleted; three ways to build the kernel (an Effect island, plain TypeScript, Effect's structure
  with our own spawner); why AutoGen and Erlang give vocabulary and pattern rather than code; three
  failure-table rows from Effect's process-group bugs.
- 2026-10-25: the trace-and-kill spike answered U1, U2 and U5. Invariant 3 now kills every process
  group the census finds, since Claude's Bash tool runs in groups of its own, and keeps SIGTERM
  first because that is when Claude cleans up and flushes. Three failure-table rows, and a note that
  events carry the account's identity.
- 2026-10-25: Group gets a tab of its own instead of living in the arena, which is treated as the
  older design: Group takes ideas from it, never code or records. The document moved from
  `arena-group-chat.md` to `group-chat.md`.
- 2026-10-25: U3 answered by a traced interactive probe: a terminals lane's spans are its own trace
  per prompt, found by session id and interaction sequence, never nested.
- 2026-10-25: U6 answered: Effect's spawner stops everything in its group on Bun, the leader-first
  case included, and nothing outside it, so the census stays ours under every option. Spike code is
  now left in its temporary folder rather than deleted.
