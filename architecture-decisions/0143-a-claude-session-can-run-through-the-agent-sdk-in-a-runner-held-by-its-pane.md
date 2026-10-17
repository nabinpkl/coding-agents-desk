---
status: accepted
date: 2026-10-17
---

# A Claude session can run through the Agent SDK, in a runner held by its tmux pane

## Context and Problem Statement

Every Claude session the panel starts is the terminal UI in a tmux pane, and everything the panel
does to it beyond reading the transcript is done to that screen: the composer is typed into
(`input/tmuxComposer.ts`), an AskUserQuestion dialog is read off the screen and answered by keys
whose meaning was measured by hand against one CLI version (`input/question/questionAnswer.ts`,
2.1.268), and the permission mode is read from the footer. Each of those breaks when the CLI redraws,
a dialog of several questions cannot be read at all, and the question only reaches the transcript
once it has been answered. The Agent SDK (`@anthropic-ai/claude-agent-sdk`) drives the same `claude`
binary over a typed protocol instead, and t3code (pingdotgg/t3code, MIT) runs Claude that way.
Touches the new `agent-feed/sidecar/src/claude-sdk/`, `agent-feed/wire/claudeSdk.ts`, the start and
Bot-launch paths (`transcripts/session-ops/forkSession.ts`), and the panel's composer.

## Decision Drivers

- Questions and approvals arrive and are answered as data, not as a screen.
- The session survives the sidecar, which restarts on every save, and so does anything it is
  waiting on: an answer given after a restart reaches the call that asked.
- One timeline. The transcript under `~/.claude/projects` is already what the catalog, the cards,
  task-state and every other surface read, including sessions the panel never started.
- One writer per transcript. Two `claude` processes on one session fork its file (below).
- The terminal stays the default and stays fully usable; this is a second way to run, chosen per
  session.

## Considered Options

- **A: keep driving the terminal UI only.**
- **B: an SDK runner as a child of the sidecar.**
- **C: an SDK runner started inside the session's own tmux pane, reached over a unix socket.**
- **D: t3code's adapter: the SDK stream translated into its own event store.**
- **E: keep the terminal UI and answer questions with a PreToolUse hook loaded by `--settings`.**

## Decision Outcome

Chose **C**. A new session can be started in SDK mode (`StartSessionCommand.claudeMode`,
`BotLaunchCommand.claudeMode`; terminal is the default). Its pane runs
`claude-sdk/claudeSdkRunnerMain.ts`, which holds one long-lived `query()` fed by a queue, so `claude`
stays up between prompts the way t3code keeps it. The runner owns every pending AskUserQuestion and
approval (`canUseTool`) and serves the whole state over `/tmp/agentdesk-sdk-<uid>/<session>.sock`;
the sidecar's `ClaudeSdkClient` holds only connections and is handed the state again on every
connect. **B** was knocked out by the restart driver: the SDK makes `claude` a child of whoever
calls `query()`, so every save would end every SDK session. **D** by the one-timeline driver: t3code
rebuilds the conversation from the live stream into SQLite because it fronts eight providers, and a
second copy of a Claude transcript here would drift from the file every other surface reads, and
would see only sessions the panel launched. **E** keeps the screen as the thing being driven, nothing
measured shows the CLI accepting answers from a hook, and a hook that waits takes the dialog away
from the keyboard. **A** is the problem.

The runner's options are fixed by measurement rather than taste (probes on 2026-10-17, SDK 0.3.302,
CLI 2.1.302):

- `thinking: { type: "adaptive", display: "summarized" }`. Without it Opus streams and stores its
  thinking as empty strings; the owner's `showThinkingSummaries: true` is not honoured in SDK mode.
- `extraArgs: { name }`, the CLI's `-n`, on a resume too: a resume without it registered as
  `agent-desk-89`, losing the session's address.
- `pathToClaudeCodeExecutable` is the installed `claude`, not the SDK's bundled binary, so an SDK
  session runs the same CLI a terminal session does.
- The status is worked out from the stream (running from a prompt or the first streamed byte to the
  result), because the CLI did not send the documented `session_state_changed` in any run.
- Prompts carry `origin: { kind: "human" }`, which the SDK says a host relaying keyboard input must.

The runner also forwards every `stream_event` it receives, and the sidecar feeds them to the live
mirror (`claude-sdk/claudeSdkLiveFeed.ts` into `ClaudeLiveBackend.acceptRunnerStream`), one flow
per message from `message_start` to `message_stop`. They are the same Anthropic events the proxy
capture decodes, so the mirror applies them unchanged, and they are the session's own account, so a
capture that dies mid-turn no longer takes an SDK session's live view with it. Measured with the
proxy removed from the runner's environment: live rows streamed and finished with the transcript's
message ids and text. An SDK session's traffic still crosses the proxy, so while a runner feeds a
session the mirror drops that session's captured flows rather than letting two writers race over
one row. Not mirrored live: the tool-result row the capture builds from the next request's body,
which the transcript still supplies, and a message whose start the sidecar missed.

### Consequences

- Good, because a question is complete and answerable from the moment it is asked: the CLI writes
  the asking turn to the transcript while it waits, multi-question calls need nothing special, and
  free text cannot be lost to an Escape.
- Good, because a question or approval opened before a sidecar restart is answered after it --
  measured on the live sidecar, and pinned by `claudeSdkClient.test.ts`.
- Good, because the SDK's protocol is the interface Anthropic maintains for this; the key-driving
  in `questionAnswer.ts` is not exercised for these sessions.
- Bad, because a session must never have two processes. Measured: a terminal resumed beside a live
  SDK runner is not refused by the CLI, each process keeps its own copy of the conversation, both
  append to one file, and the file forks at the last turn they shared. `claude --resume` then
  follows the branch named by the `last-prompt` record the last process to exit wrote, while the
  SDK's `getSessionMessages` follows the leaf on the highest line, so the two readers disagree.
  Slice 1 refuses a second runner at its socket and keeps the terminal's own restart off runner
  panes (`isClaudeSdkRunnerCommand`); the registry lock for every path and switching while idle
  are the next slice.
- Bad, because the runner's pane shows its log rather than Claude, so a reader goes to the card.
- Bad, because a running runner keeps the code it started with until its session restarts, which
  is why both sides announce `PROTOCOL_VERSION` and refuse a mismatch.
- Neutral, because the SDK releases with the CLI (same patch number, same minute), and is a caret
  dependency exempted from the owner's 48-hour `minimumReleaseAge` in `agent-feed/sidecar/bunfig.toml`
  only, so it can keep up with the CLI it drives.
- Neutral, because a fork, a cold reopen and switching between modes stay terminal-only for now: a
  fork asked for in SDK mode is refused, and a cold SDK session opened from a card resumes in the
  terminal.

### Confirmation

`claude-sdk/claudeSdkClient.test.ts` answers a question through a client created after the one that
saw it was discarded, over a real socket. `claudeSdkRunner.test.ts` pins the options above. The
idle sweep closes a runner pane like any other, and the runner's hangup handler ends the session so
`claude` writes its exit records (measured: `last-prompt` written, socket and registry row gone).

## Pros and Cons of the Options

### B: a child of the sidecar

- Good, because it is the simplest wiring: no socket, no second process to find.
- Bad, because every sidecar save ends every SDK session and everything it was waiting on.

### D: t3code's event store

- Good, because the live stream gives text deltas and run state before the file has them.
- Bad, because it is a second copy of the conversation, and it sees only sessions it started. The
  stream's deltas can still feed the existing live mirror (`live/claudeLiveMessages.ts`
  `applyStreamEvent` takes the same Anthropic events) without becoming a store.

### E: a PreToolUse hook

- Good, because the terminal UI stays.
- Bad, because whether the CLI takes an answer from a hook is unmeasured, and the screen remains
  the interface for everything else.

## Links

- ADR-0142 the composer types into a terminal session through its pane
- t3code `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (MIT, Copyright (c) 2026 T3
  Tools Inc.), snapshot of 2026-10-17; the runner's process-group spawn is adapted from it
- `@anthropic-ai/claude-agent-sdk` 0.3.302, published 2026-10-16
