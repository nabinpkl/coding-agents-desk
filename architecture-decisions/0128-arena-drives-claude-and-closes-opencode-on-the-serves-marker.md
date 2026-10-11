---
status: accepted
date: 2026-10-11
supersedes: ADR-0127
---

# Arena contestants run behind one driver seam; Claude is spawned, opencode closes on the serve's own marker

Supersedes two parts of ADR-0127 and nothing else: its opencode completion signal ("idle after
the turn was seen running") and its consequence deferring the Claude driver. Worktrees,
recording-only facts, persistence and the announce board stand as ADR-0127 records them.

## Context and Problem Statement

ADR-0127 shipped opencode contestants only and deferred Claude. Building Claude made the arena
drive two harnesses that agree on nothing below the facts: opencode is a live backend the
sidecar already holds, Claude is a CLI with no backend that can send. Driving both live, on
2026-10-11, also showed the opencode completion signal was wrong. A turn the provider refused
(a spent quota, `provider.quota` 429) never published `running` at all, so the contestant sat
on "running" until the ten-minute timeout. And the mapper counts a user row or a finished tool
step as closed, so `idle` can arrive before the model has answered.

## Decision Drivers

- One run may duel two of one harness or one of each, and the run's own code must not know
  which.
- A contestant's end is the harness's own answer, read where the harness writes it, never
  inferred from a projection built for drawing rows.
- A failure is a fact about the contestant, with the harness's reason, not a timeout.
- Contestant context is about the prompt, not this machine.

## Decision Outcome

- **The seam** is `arena/contestantDriver.ts`: a `ContestantPlan` (prompt, worktree, request
  id, timeout, `onSessionId`) in and a `ContestantResult` (session id, events, usage) out. The
  run reads the facts off event blocks once, whichever driver produced them. `server.ts` wires
  one driver per `ArenaContestantSource` (`opencode | claude`), and a source with no driver is
  refused with 400 before any worktree exists. This is the "shell out later" boundary: a
  remote or VM driver replaces a function, not the run.
- **Claude** is `claude --print --safe-mode --session-id <chosen> [--model] [--effort]
  --allowed-tools Read,Grep,Glob,Bash,Edit,Write`, spawned with an argv rather than a shell
  string, with the prompt on stdin and the worktree as cwd. The process exit is the close;
  non-zero fails the contestant with stderr's tail; the timeout kills it. Facts come back from
  the transcript, found by its session id rather than by rebuilding the project slug, and read
  through `claudeAdapter.processLine`, with machinery lines skipped. Model and effort are
  machine config (`AGENT_FEED_ARENA_CLAUDE_MODEL`, `_EFFORT`), not per run, for now.
- **Opencode closes on the serve's marker.** The serve ends every turn with an `idle` message
  carrying `outcome: succeeded | failed`, and a failed turn's assistant message carries the
  `error`. Every non-`running` envelope prompts one read of the session's tail (one read in
  flight, one follow-up a second later when it was inconclusive), and only the marker after
  the last user message closes the contestant. `failed` fails it with `<type>: <message>`.
  The SDK's message union predates the `idle` message, so it is read loosely.
- **File facts across harnesses**: tool names are compared lowercased (`read` vs `Read`), and
  only read and write tools may name a file from their input. A search tool's `path` is the
  directory it searched.

## Consequences

- **Context is not symmetric between harnesses, and the run does not pretend it is.**
  `--safe-mode` drops this machine's hooks, CLAUDE.md, skills and MCP servers from a Claude
  contestant. An opencode contestant on the shared serve still inherits the serve's global
  plugins (ADR-0127). Same prompt, different machine context: a bake-off result can carry it,
  and the escape is still the VM-per-contestant shape.
- **The opencode success path under the marker rule is pinned by unit tests against messages
  copied from a real succeeded session, not by a live run**: the serve's provider quota was
  spent on the day this landed. The failure path was verified live, in the API and on the tab.
- The store reload accepts both sources. Its first version accepted only `opencode`, and a
  sidecar that had run one Claude contestant then refused to boot.
- A failed opencode turn currently draws nothing in the session's own thread, because the
  mapper drops the `idle` marker and the error. The arena card now names the reason. The
  thread view gaining a failed-turn row is a separate change to a shared mapper.
