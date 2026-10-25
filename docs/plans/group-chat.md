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

## Why Group: one hop to the sessions you already have

Recorded 2026-10-25 as the case for Group. It is an idea to explore, and it may not survive contact;
it is written down so the reason is not lost if it does not.

Today, handing work to a session that already owns it (say, the one handling the site's
performance) is two hops either way: find its card on the Canvas, then message it; or tell the
Father (the one session per machine kept in a floating window) and let it relay, which costs the
Father a turn to decide and another to pass it on. In a room it is one hop: a message with
`@name`, or with no mention at all ("who is looking after site performance?"), and the session it
concerns answers there.

So one room has two modes:

1. **Command line.** The members are sessions you already have, each doing its own work. They do
   not trip over each other: a member speaks only when a message is meant for it, by a mention
   or, later, by routing. No rounds. The cost is that a member that joins later never saw what
   was said before it joined; it gets only what is meant for it from then on.
2. **Working together.** The rounds, the mentions between agents and the budget described below,
   for agents Group starts for a task.

**What the command line loses is steering.** Directing a session from its card, you watch how it
sets about the task, and the first phase (its first output, its first tool calls, the approach it
picks) matters more than anything later; that is when you would stop it. In a room you see only
its answer. The answer to that: every message the room delivers names the session it went to, and
opening it shows that turn from its first output, so the approach is one click away rather than a
search. A live peek of a turn's first events inside the room can come later.

**Who answers an unaddressed message** is open (below). Three ways:

- Code matches the message against each member's name, its Bot, and the task it last set
  (`set_task`). Free and predictable; it will miss.
- Every member is woken to decide, as Grok Bot does. That is a turn for every member on every
  message, and it is where Grok's reports of loops come from.
- One cheap model call over the roster picks a member, and the room shows the pick as it delivers.
  The router only chooses among members; it grants nothing, so it holds no brake.

The lean is the first, with the third behind it when the first finds nobody.

**What it changes in the kernel.** In command line mode the members are sessions Group did not
start, mostly terminals in tmux. Group cannot kill them, since they are the reader's own sessions;
its stop is to interrupt the turn it caused (an interrupt in the pane, `abort` for opencode) and
to deliver nothing more. Leases and the budget still bound every turn Group causes; the process
kill applies only to lanes Group itself started. Its turn is found by session id (U3).

**How a message reaches an existing session, as built today** (checked 2026-10-25,
`docs/agent-messaging.md`, `agent-feed/sidecar/mods/README.md`). Every Claude session the sidecar
launches, resumes or forks, in its terminal mode (the default, in a tmux pane) and in its Agent SDK
runner mode, loads three mods: `agentdesk-hub` delivers messaging-hub messages as prompts,
`prompt-guard` limits every prompt a mod submits, and `ask-owner` gives the session a tool for
asking the owner. OpenCode sessions get hub messages through the sidecar's adapter. A session is
reachable only while it belongs to a published Bot. So Group's delivery into an existing session
is the hub's, and is not something to build again: Group posts to the member's Bot address, and the
mod or the adapter puts it into the session.

That path brings limits Group has to design under, not around. `prompt-guard` lets mods put in 3
prompts per session since the person last typed there, one at a time, 6 per session and 20 per
machine in an hour, never the same text twice in 10 minutes, with a pause for every session on the
machine. A wave that sends one Claude member more than three messages before you type in it again
is cut off by the guard, and the guard is right to: it is the brake already on this machine, and it
fails closed. So in command line mode Group's own budget sits inside the guard's, and Group shows a
delivery the guard dropped as dropped, rather than as sent. A Claude Code session holds a mod's
prompt until its running turn ends, so a message to a busy member waits for that turn.

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
5. **A reader watches; it never owns work.** A browser that disconnects or reloads, and in the dev
   loop that is many times an hour, ends only its own watching: its stream, and anything started
   to serve that stream. A wave, a turn and a lane belong to the room, whose lifetime is the
   room's leases on disk, never a request's. With Effect this is a matter of which scope work is
   forked into: a request's scope for the stream, the room's for the work (U8 shows both).

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
   Group process's only recovery is to kill what has expired and mark it failed, and to adopt
   what is still running under a live lease, before it admits anything. A turn is never sent
   again on its own: delivery to an agent is at most once. A traditional chat retries until
   delivered; a paid turn must not.
   - **A lane belongs to its lease, not to the process that started it.** Group restarts often in
     the dev loop, and a graceful exit runs every scope's cleanup, so a lane tied to a scope dies
     with each restart (U9 measured it). A lane is started, then released from its scope
     (`unref` on Effect's handle), and only an explicit stop, an expired lease or a tripped
     breaker kills it. So a restart, graceful or a crash, is the same event to a lane: the next
     process finds it by its lease and carries on watching.
   - **A lane writes to files, never to a pipe into Group.** Its transcript and its output go to
     disk, so the process that reads them can change under it.
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
| Group exits gracefully mid-turn (a save in its files, the supervisor's SIGTERM) | The lane is not in any scope's cleanup; it runs on and the next process adopts it by its lease | A lane mid-turn, Group sent SIGTERM and restarted (U9: an ordinary scoped child died at tick 7 of 30; a released one finished) |
| Group crashes mid-turn | Same as a graceful exit | Group SIGKILLed mid-turn (U9: the lane finished) |
| Effect stops skipping released children on scope release | The restart test fails before an upgrade ships | The U9 graceful-restart test, kept in the suite: skipping released children on release is in Effect 4.0.6's code, not its documentation |

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
| U8 | Does Bun report a stream reader leaving? On the tile path in August 2026 it never did, neither `request.signal` nor the stream's cancel | Effect stops a request's work when its signal aborts, and every framework's own "on abort" depends on the same signal | An SSE server on Bun 1.3.13, plain and on Effect, read by clients that leave, directly and through the panel's dev proxy |
| U9 | When Group's own process restarts (a save in its files, a crash), do its lanes die with it, or are they picked up again? | In the dev loop Group restarts often; Effect runs a scope's finalizers on a graceful exit, so a lane tied to the room's scope would be killed by every restart, losing its turn | A lane mid-turn, Group sent SIGTERM and started again |

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
- **U7, Effect's spans into the archive: answered, through a bridge of our own.** Tested with the
  sidecar's own Sentry setup (`@sentry/bun` 11.6.0, static transactions, a transport that hands each
  envelope on) and `effect` with `@effect/opentelemetry` 4.0.6 on Bun 1.3.13.
  - `@effect/opentelemetry`'s global-tracer layer reaches nothing: Sentry 11 on Bun registers no
    global OpenTelemetry provider (the global was `NoopTracerProvider`), so every Effect span was
    dropped, silently, with no error.
  - An Effect `Tracer` of our own whose spans are Sentry spans (about 70 lines over
    `Sentry.startInactiveSpan`) works: Effect spans nested under the Sentry span active where they
    started, two lanes in parallel fibers each kept their own parent and children, attributes and
    `annotateCurrentSpan` arrived, and a failed effect's span had an error status. An Effect span
    with nothing around it became a transaction of its own.
  - One direction does not nest yet: a Sentry span started inside an Effect span became a separate
    transaction, because the bridge does not make its spans Sentry's active span. Effect's tracer
    has a `context` hook for running a fiber under such a context; the bridge would use it.

  So A and C need no second tracing stack, but they do need that bridge, which is ours to keep.
- **U8, a reader leaving: answered, and Bun reports it now.** Bun 1.3.13, an SSE response from a
  `ReadableStream` written every 200 ms, read for about a second by four kinds of client: curl
  giving up, curl killed with SIGKILL (a browser crashing), an aborted `fetch`, each directly and
  through the repository's own `proxyToSidecar` (the panel dev server's hop).

  | Server | What it saw when the reader left |
  | --- | --- |
  | Plain `Bun.serve` | `request.signal` aborted and the stream's `cancel` ran, both within 1 ms, in every case; writing stopped |
  | Effect's Bun server | The request's stream ended within a second in every case |
  | Work forked into the room's scope from that same request | Ran to its end every time, never interrupted |

  So the August result does not hold for Bun 1.3.13 on a stream of this shape, and principle 5
  holds on Effect by construction. Not covered: the browser's own HTTP/2 hop into the dev server,
  and the tile path's stream shape.
- **U9, a Group restart and its lanes: answered.** A stand-in for Group on Effect 4.0.6 started a
  lane (a script ticking 30 times, 200 ms apart), wrote its lease (pid and start time), and was
  stopped after 1.5 seconds; a second process then read the lease and adopted the lane if it was
  the same process.

  | Case | The lane |
  | --- | --- |
  | An ordinary scoped child; Group sent SIGTERM | Killed at tick 7: the graceful exit ran the scope's cleanup, and the turn was lost |
  | Released with `unref` after it started; SIGTERM | Ran on, was adopted (same pid, same start time), and finished its turn |
  | Released, and writing to a pipe Group held; SIGTERM | Also finished. It was `sh`; a real `claude` may treat a closed pipe differently, so this proves nothing for it |
  | An ordinary scoped child; Group SIGKILLed | Finished: no cleanup runs on SIGKILL |

  So graceful and crash restarts differed only for the scoped child, which is the design to avoid.
  Effect's spawner skips a released child on scope release (4.0.6, in its code, not its
  documentation, which only says the parent may exit without waiting). An adopted lane is not the
  new process's child, so it cannot be waited on: a real one is watched through its transcript.
  The kernel's invariant 4 and the failure table now say so.
- **Still open:** U4 (opencode).

## How the kernel is built: three options

The sidecar runs on Bun with Promise-based code. Effect (a TypeScript library for structured
concurrency) fits the shape of this work: processes tied to scopes, interruption that runs every
child's cleanup, timeouts, retries, and spans that follow the work's structure. Its core runs on any
runtime; processes, files and HTTP come from platform packages (node, bun, deno, browser).

| | A. An Effect island | B. Plain TypeScript | C. Effect's structure, our own spawner |
| --- | --- | --- | --- |
| Supervision | Scopes and fibers: Stop interrupts the room's scope and every child's cleanup runs | The lane state machine, written by hand | Scopes and fibers, as A |
| Kill and wait | Effect's `ChildProcess` (detached group, `forceKillAfter`, then SIGKILL, then a wait on the group), plus our census and start-time check, which it does not do | Our own, about 300 lines, with Effect's three bugs as failure-table rows | Our spawner behind Effect's `ChildProcessSpawner` interface, census and start-time check included |
| Spans | `withSpan`, through our own Effect tracer onto Sentry's span API (U7: `@effect/opentelemetry` reaches nothing here) | The Sentry spans the sidecar already makes | As A |
| Precedent | t3code, on Node with Effect's Node spawner | The sidecar's own `claudeSdkRunnerMain.ts` | OpenCode v2: Bun, Effect's interfaces, and its own 556-line `cross-spawn-spawner.ts` |
| Risk | The interlock rests on a module Effect marks unstable, with three process-group bugs fixed in September and October 2026; two concurrency models meet at a Promise boundary that interruption does not cross | More code of our own, and a class of structured-concurrency bugs to avoid by hand | Effect still spreads through every caller; the kill stays ours to get right |

Common to all three: Effect's three bugs are rows in the failure table above, whichever is chosen.
Costs of Effect in general: it spreads to every caller, people report two to eight weeks to become
productive, and v4 renamed modules that models know by their v3 names.

U6 and U7 are settled: Effect's spawner behaves on Bun, and Effect's spans reach the archive through
a small tracer of our own. Nothing measured stands in the way of any of the three.

**Decided 2026-10-25: A, Group is built on Effect, as a pilot.** The lean had been B or C, on the
Simplex argument that the part holding the envelope should be small and ours. The reason to go
further: Group is mostly the outside world (processes, streams, timeouts, interruption, a hub, a
supervisor tree), which is where Effect's model of typed effects, scopes and structured concurrency
is meant to be strongest, and the closest projects, OpenCode on Bun and t3code on Node, both build
their harness supervision on it. Group is the place to find out whether it holds up here. If it
does, the rest of the sidecar can move to Effect later, as those two did; if it does not, the
damage is one feature's.

What A still owes, from the spikes: the census of a lane's descendants and the start-time check are
ours on top of Effect's spawner (it reaches nothing outside its group, U6); every stop passes
`forceKillAfter` (without it, a process ignoring SIGTERM is waited on forever); spans go through our
own tracer onto Sentry (U7), with its `context` hook still to do; and the process module is one
Effect marks unstable, so its version is pinned and its changes read before each upgrade.

## Where Group lives

Decided 2026-10-25: a **Group** tab of its own in the panel, and a home of its own on the server
side, so that earlier designs do not seep in. Earlier code is read for **behaviour priors**, what
it measured and the traps it found (the tmux pipe race, Bun's poisoned second watch, the prompt
guard's limits, the arena's lanes that time out without stopping), and never for **architecture
priors**: Group does not import the arena, and does not take its structure from the sidecar's
modules.

The server-side home, settled 2026-10-25 in ADR-0155: **`agent-feed/group/`, a package of its
own**, with its own `package.json`, `tsconfig.json`, `.oxlintrc.json`, ast-grep rules and tests, and
a gate leg of its own (`agent-feed-group-check`). It is the third home recorded that day, each from
a measurement the one before lacked:

1. A package of its own was proposed first and dropped, because the messaging hub's package
   (`agent-feed/hub/`) has no leg in `just check`, so a package seemed to fall outside the gate.
2. Then `agent-feed/sidecar/src/group/`, its own process inside the sidecar package, with its rules
   as oxlint overrides. Building the lint showed the two fighting in four places: oxlint gives a
   rule the options of the last override that matches, so a Group test file's three overrides
   decided its rules by their order; a tsconfig covers a whole program, and t3code's
   `exactOptionalPropertyTypes` gave 108 errors in 53 sidecar files; `@effect/tsgo` patches the
   package's compiler; and `@effect/vitest` fails under the sidecar's `bun test`.
3. So a package again, with the gap in (1) closed by wiring: a leg in the `justfile`, Group's paths
   in fitness checks 5 to 9 and the pre-commit hook, and its own lint config run with `-c`.

What still holds from (2):

- **The isolation comes from the process.** The audio process is the precedent: an entry point the
  supervisor runs as its own child, replaced only when its own files change, on a port of its own,
  reached from the panel's dev server at `/api/audio/`. Group is the same at `/api/group/`, from
  `agent-feed/group/src/GroupMain.ts`: a hang or a crash in Group never takes the sidecar's streams
  down, and a save elsewhere never restarts a room mid-wave. The supervisor runs a child from
  another package already (the speech process, `agent-feed/speech/`).
- **Group imports nothing from the rest of the repository**, and the sidecar imports neither Group
  nor Effect, both refused by lint; what Group needs from the sidecar (sending through the hub, the
  session catalog, transcripts) it asks for over the sidecar's HTTP routes, as the panel does.
- **Effect's HTTP router lives inside Group's process only**; the sidecar's route chain is
  untouched.

What it costs: the wiring above, and lint rules copied from the sidecar's config rather than
inherited, so a lesson added there reaches Group only when it is copied. Tests run on `bun test`
through a helper adapted from OpenCode's (`src/testing/effectTest.ts`), the same runner and runtime
as the sidecar's. Built that day: the package, one health endpoint, its OpenAPI document and four
tests; the supervisor does not start it and the panel does not route to it yet.

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
- **knip (unused files, exports and dependencies): with Group's first module, not before.** It
  passes vetting (ISC, released weekly, 6.43.0 on 2026-10-24) with one caveat: a single maintainer.
  t3code runs it. Run read-only at 6.40.0 on 2026-10-25 without configuration, it reported 28
  unused files and 178 unused exports in the sidecar, and 5 files and 76 exports in the panel, but
  `src/server.ts` and the other entry points were among the "unused" files, so most of that is
  missing configuration, not findings. For Group it would be a config in its package whose entries
  are the `*Main.ts` files and tests, reporting files, exports and types. It lands with Group's first
  real module and a probe that fails it. Running it over the rest of the tree is a separate decision,
  with its own backlog to clear.

## Open decisions

- Whether agents touch code: talk only, a worktree each, or one shared tree.
- Who speaks after round 1: only agents mentioned (proposed), everyone each round, or one at a time.
- Defaults: rounds per wave (proposed 3), the lease (proposed the arena's 10 minutes, 2 for the smoke
  run), the grace before SIGKILL (proposed 5 seconds), and a hard maximum the reader cannot exceed.
- Whether Claude's own telemetry export may be a source, which amends an AGENTS.md rule.
- When to restart the opencode serve with a span endpoint, to answer U4.
- How an unaddressed message finds its member in command line mode: matching by code, a cheap
  router call, or both (proposed: code first, the router when code finds nobody).
- Which mode the first slice builds: command line (existing sessions, no rounds, no process kill)
  is the smaller one and the one with the clearest daily use.

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
- 2026-10-25: U7 answered: `@effect/opentelemetry` drops every span under Sentry 11 on Bun, which
  registers no global provider; an Effect tracer of our own onto Sentry's span API carries them,
  except Sentry spans started inside Effect, which need its `context` hook. Only U4 is open.
- 2026-10-25: the case for Group recorded: one hop to sessions you already have, where the Father
  is two. A command line mode beside working together, its cost in steering and the click that
  answers it, three ways to route an unaddressed message, and what it changes in the kernel.
- 2026-10-25: delivery into existing sessions corrected to what is built: the hub, through the
  `agentdesk-hub` mod for Claude in both modes and the adapter for opencode, under `prompt-guard`'s
  limits, which Group's command line mode works inside. `docs/agent-messaging.md` brought up to date
  with the same facts.
- 2026-10-25: decided that Group is built on Effect (option A) as a pilot for the sidecar, with a
  tab of its own and a home of its own; earlier code is read for behaviour priors, not
  architecture priors. Proposed that home: `agent-feed/group/`, a package and a supervised process
  reached at `/api/group/`, following the hub's package and the audio process.
- 2026-10-25: principle 5, a reader watches and never owns work, since browser and sidecar reloads
  are routine in the dev loop. U8 answered: Bun 1.3.13 reports a reader leaving within 1 ms,
  directly and through the panel's proxy, and Effect then ends only the request's stream while
  room work runs on. U9 opened: what a restart of Group's own process does to its lanes.
- 2026-10-25: U9 answered: a scoped lane dies with every graceful restart, a released one is
  adopted by its lease and finishes. Invariant 4 now says a lane belongs to its lease and writes to
  files, and the failure table gained the graceful restart, the crash, and Effect changing the
  behaviour this rests on. Only U4 is open.
- 2026-10-25: Group's standards set before its first line: `docs/agents/group.md` (routed from the
  root `AGENTS.md`), the `group-effect` and `group-api-design` skills in `.agents/skills` (with
  `.claude/skills` pointing there), the API after Zalando's RESTful API Guidelines. The existing
  codebase is behaviour to port, never a precedent for departing from them.
- 2026-10-25: the owner approved snake_case JSON for Group's API (Zalando #118, unlike the rest of
  the panel's wire) and the list of Zalando rules out of scope for Group.
- 2026-10-25: the standards are enforced on every gate: oxlint keeps Group (at
  `agent-feed/sidecar/src/group/`, its own process in the sidecar package) from importing the rest of
  the sidecar and Effect from spreading outside it, and ast-grep runs ten Effect rules over Group's
  code, nine copied from OpenCode under MIT and one Group's own.
- 2026-10-25: "Where Group lives" corrected to the home the lint was written against: its own
  process inside the sidecar package at `agent-feed/sidecar/src/group/`, not the separate package
  proposed earlier, which would have fallen outside every gate leg as the hub's does.
- 2026-10-25: two more ast-grep rules for Group, both Group's own: files and processes are reached
  through Effect's services except in a `*Main.ts` entry point and tests, so a file's dependencies
  show in its type, and a Node built-in is imported as a `Node`-named namespace, after t3code. knip
  was looked at and waits for Group's first module ("Libraries and runtimes considered").
- 2026-10-25: Group is its own package, `agent-feed/group/` (ADR-0155), after its rules were found
  fighting the sidecar's in four places; "Where Group lives" keeps the three homes in order. The
  skeleton is built: one health endpoint, the OpenAPI document, tests on `bun test`, its own
  compiler settings and lint, and a gate leg. Not yet started by the supervisor or routed by the
  panel.
- 2026-10-25: Group checks itself with its own toolchain at each tool's latest release (ADR-0156):
  TypeScript, `@effect/tsgo` (Effect's type-aware checks, which `tsc` does not run), oxlint, oxfmt
  and ast-grep are its own dev dependencies, its gate leg runs them all, and its `bunfig.toml` turns
  off the release-age wait. The panel's lint tools moved to oxlint 1.89.0, oxlint-tsgolint 7.0.2005
  and oxfmt 0.74.0 the same day, with no new finding and no file reformatted.
