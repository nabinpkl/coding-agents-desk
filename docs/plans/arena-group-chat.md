# Arena group chat

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

A room in the arena where you and two to six agents (Claude or opencode lanes) talk. You post; an
agent's reply is its turn's answer; @mentions say who should speak next. The arena's runs today
send one prompt to every lane and compare what each did. A room instead lets the lanes answer each
other.

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
   - A spawned harness gets a process group of its own. Stopping it is SIGTERM to the group, a short
     grace, SIGKILL to the group, then a check that the group is empty.
   - macOS has no cgroups, so a grandchild that starts a session of its own escapes the group. A
     snapshot of the lane's descendants is taken before the kill, and each one is signalled.
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
outlive the CLI. The stop primitive and the lease belong in a shared module that the arena's
existing lanes also switch to, not in `arena/`, which is at its twelve-file cap.

## The protocol (class B)

- **The room log** is the one source of truth: an append-only file in the run's folder. Each message
  has an author (you or a lane), its text, the mentions read from it, and the next number in the
  room, assigned by the sidecar as its only writer. No wall clocks order it. Lane transcripts stay
  each session's own record.
- **Each agent has a cursor:** the last number delivered to it. Its next turn gets the messages after
  its cursor, not the whole log; its session already holds the rest.
- **An agent's message is its turn's answer,** read off the closed turn as passes already do
  (ADR-0152). Mentions are read from the text by code. "Pass" is silence. Nothing has to be called
  to post, so there are no per-message permission prompts.
- **Rounds:** your message opens a wave. In round 1, every agent you addressed answers in parallel
  (the start line the arena already has). In each later round, only agents mentioned in the round
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
(its monitoring docs, read 2026-10-25). Interactive sessions ignore an inbound one. Using that needs two things: a sidecar route that takes OTLP into the same
archive, and an amendment to AGENTS.md's rule that what a feature knows about a live session comes
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

Found while designing this; they are bugs whether or not a room is built.

- A headless Claude lane's timeout sends SIGTERM to `claude` alone, with no SIGKILL after, and leaves
  whatever it started (`arena/contestants/claudeContestant.ts`, the timer in `runClaudeContestant`).
- An opencode lane's timeout marks it failed and never aborts the session, though the backend can
  (`arena/contestants/opencodeContestant.ts`).
- A terminals lane's timeout marks it failed and leaves the pane running
  (`arena/contestants/terminalContestants.ts`).

So a timeout today stops the arena waiting, not the lane spending.

## The first slice

The smallest end-to-end room that is kept and grown (a walking skeleton):

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

## Open decisions

- Whether agents touch code: talk only, a worktree each, or one shared tree.
- Who speaks after round 1: only agents mentioned (proposed), everyone each round, or one at a time.
- Defaults: rounds per wave (proposed 3), the lease (proposed the arena's 10 minutes, 2 for the smoke
  run), the grace before SIGKILL (proposed 5 seconds), and a hard maximum the reader cannot exceed.
- Whether Claude's own telemetry export may be a source, which amends an AGENTS.md rule.

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

## Change log

- 2026-10-25: opened from a design conversation: principles, the kernel, supervision, protocol,
  telemetry, outside calls, the first slice, the gaps found in today's arena.
