---
status: proposed
date: 2026-10-19
---

# A role session registers its agent log with the sidecar, found through the rendezvous board

## Context and Problem Statement

The area manager sessions (Lint, Telemetry, Tests) each keep a decision log at
`.agents/agents-log/<area>-manager.log`, one line per decision or finding. Nothing ties a log to the
session keeping it, so a session card cannot offer it. The card's summary (`summary/summaryRuntime.ts`)
stays as it is; this adds a second, direct way to see what a role session decided, on the sessions
that keep a log and on no others. An agent knows its own session id (`CLAUDE_CODE_SESSION_ID`, set in
every Claude session and inherited by what it runs) but not its Bot, and it has no documented way to
reach the sidecar. Touches `agent-feed/wire/bot.ts`, `bots/botStore.ts`, a new route beside
`http/session-routes/bracketRoutes.ts`, `http/agent-routes/handoverRoutes.ts`, a new
`tools/agent-log-register.sh`, `.agents/agents-log/AGENTS.md`, and the Bot session card.

## Decision Drivers

- The button appears only where a log is kept, from a fact someone stated, not from a guess.
- A failed registration never loses a log line, and says that it failed.
- Finding the sidecar does not depend on an accident of how a process was started.
- Works without git: the tie must not need a hook installed or a commit made.
- Nothing is written into Claude's own files, and no new filesystem watch is opened.

## Considered Options

How the tie is made:

- **A sidecar route the session calls**, stored on the Bot record.
- **A commit trailer**: a `prepare-commit-msg` hook adds `Agent-Session: claude:<id>` to commits that
  touch a log, and the sidecar reads the trailers from history.
- **Inference from the transcript**: the sidecar notices which session wrote to a log.
- **A "kept by" line in the log's header.**

How the session finds the sidecar:

- **The rendezvous board**: `<registry>/<user>.json`, which the sidecar rewrites every 5 seconds
  (`sidecarRegistry.ts`) with its host, port, pid and heartbeat.
- **The inherited `AGENT_FEED_HOST` and `AGENT_FEED_PORT`.**
- **A fixed `127.0.0.1:7682`.**

## Decision Outcome

Chose **the sidecar route** for the tie and **the rendezvous board** for the address.

The commit trailer is out because it needs git, a hook that `just git-hooks-install` has to have
linked, and a commit, before any button appears; a log written in a directory without them is never
tied. Inference is out because the transcript's view of writes covers only the Write and Edit tools,
and the writes to `lint-manager.log` so far all went through Bash. A header line is out because a
session id changes at every fork and handover and means nothing on another machine, while the log
travels in git.

The inherited variables are out because they are there by accident. The host sets them on the sidecar
(`AgentFeedSidecarProcess.swift`), and sessions get them only because they run on the default tmux
server, whose global environment was copied once from whichever sidecar's `new-session` started that
server (30 September, on the machine this was measured on). Neither name is in tmux's
`update-environment`, so a tmux server started first by anything else gives sessions neither, and a
sidecar moved to another port leaves them stale. A fixed address is a hardcoded config, which the repo
does not allow. The board is the one place the sidecar states where it is, kept fresh, and already
read by the panel's dev server.

### The shape

1. **The field.** `BotRecord` gains `sessionLogs?: Record<string, string>`, keyed by
   `source:sessionId` like `sessionAnchors`, valued with a path relative to the Bot's directory. As
   with anchors, detaching a session keeps its entry, so a reattach restores it. `BotView` extends
   `BotRecord`, so the panel receives it with no view change. `botStore.ts` validates the field
   beside `isSessionAnchors`.
2. **The route.** `POST /api/sessions/:source/:sessionId/log`, body `{ "path": "<relative path>" }`,
   beside the bracket route and addressed the same way: by the session, with the sidecar finding the
   Bot that holds it. It refuses a session no Bot holds, a path that is absolute, leaves the Bot's
   directory, is not under `.agents/agents-log/`, does not end in `.log`, or does not exist yet.
   Setting the path a session already has changes nothing, so calling it on every write is safe.
3. **The script.** `tools/agent-log-register.sh <path>` finds the board with
   `node tools/runtime-paths.mjs sidecar-registry`, reads `<user>.json` for the user running it (the
   board also holds other login sessions' files, some long dead), refuses a heartbeat older than
   15 seconds (the panel's `SIDECAR_STALE_MS`), requires `CLAUDE_CODE_SESSION_ID`, and posts to the
   route. It exits non-zero with the reason: no descriptor, a stale heartbeat, a refused connection, or
   the route's refusal.
4. **The instruction.** `.agents/agents-log/AGENTS.md` gains one step: after appending a line, run the
   script. If it fails, keep the line, commit as usual, and say in the reply that registration failed
   and why. The next write runs it again, so a missed call heals itself.
5. **Handover and fork.** `handoverRoutes.ts` copies the predecessor's entry to the new session where
   it already attaches that session to the Bot, so the successor shows the log at once. A fork gets
   no entry: it is not the keeper.
6. **The button.** On the Bot session card and in the session modal, beside `SessionCodeButton`, shown
   only when `bot.sessionLogs` has the session's key. It opens the session's existing code viewer on
   that file (`useSessionCode` already opens on a file). A view that lays the log out in its columns
   is later work.

### Consequences

- Good, because the button appears exactly where a session said it keeps a log, and nowhere else.
- Good, because registering needs no git, no hook and no commit.
- Good, because a sidecar that is down costs only the button, until the next write that finds it up.
  The log line itself never depends on the call.
- Bad, because it trusts the agent to run the script. An agent that never does gets no button, and
  nothing reports the absence. Accepted until the tool below replaces the script.
- Bad, because any session in the Bot can register any log under `.agents/agents-log/`, so two
  sessions can show the same log. Accepted: these are this owner's own agents.
- Neutral, because the summary is unchanged and still offered on every session.
- Neutral, because a session without `CLAUDE_CODE_SESSION_ID` cannot use the script. Whether opencode
  sessions carry an equivalent is not checked.

### Later, not decided here

- **An empty log button** on a session with no log, offering to start one. It sends the session a
  message asking it to keep a log at a suggested path, and the session's first write registers it.
- **A `keep_log` MCP tool** in `agent-feed/hub/src/mcp.ts` beside `set_task`, which already forwards
  a session's request to the bracket route. It would forward to this route, and the script would
  retire. The route is the base of both.

### Open questions

- One log per session, or several. Drafted as one (a string per key); several would make the value a
  list.
- Whether the first version opens the code viewer on the file, as drafted, or a view of its own.
- Whether to also stop the inherited `AGENT_FEED_HOST` and `AGENT_FEED_PORT` from going stale, or
  leave them unused.

### Confirmation

The route's test pins every refusal, the Bot lookup by session, and that a repeat call changes
nothing. `botStore.test.ts` pins that a record with `sessionLogs` loads and a malformed one is
refused. The handover route's test pins the copied entry. The card's test pins that the button is
absent without an entry and present with one.

## Links

- `agent-feed/sidecar/src/http/session-routes/bracketRoutes.ts`, the session-addressed route this copies
- `agent-feed/sidecar/src/sidecarRegistry.ts`, the board's writer
- `packages/AgentPanel/Web/src/app/dev-server/sidecarBoard.ts`, the board's reader and `SIDECAR_STALE_MS`
- `.agents/agents-log/README.md`, the log format
