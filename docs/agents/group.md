# Working on Group

Group is the group chat tab and its own server process (`docs/plans/group-chat.md`). It is built
fresh, on Effect, to standards set before its first line, in a package of its own:
`agent-feed/group/`, with its own `tsconfig.json`, `.oxlintrc.json`, ast-grep rules and tests
(ADR-0155). This page is read before any change to Group's code, its tests, or the panel code that
calls it; `agent-feed/group/AGENTS.md` has the package's commands.

## The standards, and no escape hatch

| Area | Standard |
| --- | --- |
| Effect: services, errors, tracing, scopes, child processes, tests | the `group-effect` skill (`.agents/skills/group-effect/SKILL.md`) |
| The HTTP API: resources, payloads, errors, idempotency, streams | the `group-api-design` skill (`.agents/skills/group-api-design/SKILL.md`), after Zalando's RESTful API Guidelines |
| The design itself: the kernel's invariants, the failure table, what is decided and what is open | `docs/plans/group-chat.md` |
| Everything every change in this repository follows: file and directory caps, no relative imports, lint, format, commits by pathspec | the root `AGENTS.md` |

Skills live in `.agents/skills/`; `.claude/skills` points there, so Claude and other agents read one
copy. The parts of them a tool can check are checked by the `agent-feed-group-check` leg, with
Group's own toolchain: its compiler settings, Effect's type-aware checks (`@effect/tsgo`), its own
oxlint config and ast-grep rules (`agent-feed/group/ast-grep/`), its formatting and its tests. The
repository's oxlint config keeps Effect and Group out of the sidecar (`group-effect`, "What the gate enforces"). Group's config copies the
rules the sidecar learned rather than inheriting them, so a lesson added to the sidecar's lint is
copied into Group's when it applies there too.

**The existing codebase is not a precedent for Group.** The sidecar and the panel grew feature by
feature, steered bug by bug: the sidecar matches HTTP paths by hand in a chain of handlers, answers
camelCase JSON, invents an error shape per route, and has no schema at its boundaries. None of that
is a reason for Group's code to depart from its standards. "The rest of the repository does it this
way" is not an argument in a review here. When a standard is wrong for Group, change the skill or
the design doc first, with the reason and the date; then the code.

## Port behaviour, not architecture

What the existing code is good for is what it found out: measurements and traps that cost real
debugging. Group carries those over as behaviour, each as a test that pins it, written in Group's own
structure. It never imports the sidecar's or the arena's modules, copies their shape, or wraps them,
and its lint refuses an import from outside its package.
What Group needs from the sidecar (sending through the messaging hub, the session catalog,
transcripts) it asks for over the sidecar's own HTTP routes, as the panel does.

Behaviour priors, and where they were learned:

- **Stopping a process tree.** SIGTERM first, then SIGKILL to every group a census of descendants
  finds: Claude's Bash tool runs commands in groups of their own, and on SIGTERM Claude cleans up
  its tree and flushes its spans (`docs/plans/group-chat.md`, "What the spike found"). MCP servers'
  children outlive the CLI (`agent-feed/sidecar/src/claude-sdk/claudeSdkRunnerMain.ts`).
- **A turn that times out has to be stopped, not abandoned.** The arena's lanes are marked failed
  and keep running (`docs/plans/group-chat.md`, "Gaps in today's arena").
- **Mods may put in 3 prompts per session until the person types** (`prompt-guard`,
  `agent-feed/sidecar/mods/README.md`); Group's deliveries into a Claude session sit inside that
  limit.
- **How a message reaches a session**: through the messaging hub, by the `agentdesk-hub` mod for
  Claude and the adapter for opencode, only while the session is in a published Bot
  (`docs/agent-messaging.md`).
- **Exclusive resources are torn down before they are opened again** (one pipe per tmux pane), and
  **a watch closed under Bun poisons the next one on that path** (`agent-feed/sidecar/AGENTS.md`).
- **A test waits for what it expects, never for a length of time** (`agent-feed/sidecar/AGENTS.md`).
- **Bun 1.3.13 reports a reader leaving** within a millisecond, directly and through the panel's
  dev proxy (U8); an earlier measurement on the tile path found it never did, so measure, do not
  assume.
- **The dev loop restarts things many times an hour**: a reader watches and never owns work, and a
  lane belongs to its lease, not to the process that started it (U8, U9).
- **Never add a `server.proxy` entry to the panel's Vite config**; `/api/group/` is routed the way
  `/api/audio/` is (`docs/agents/dev-loop.md`).

A behaviour not on this list, found in old code, is checked before it is ported: re-measure it on
the current versions, then write it here.

## References on disk

Full clones, git-ignored, read-only (`.gitignore` says how to recreate them):

- `.reference/effect`: Effect itself, the source of truth for its API.
- `.reference/zalando-api-guidelines`: every API rule under its number.
- `.reference/opencode`, `.reference/t3code`: the two projects closest to Group, both on Effect;
  OpenCode's ast-grep rules for Effect patterns (`script/ast-grep/`) are the starting point for
  Group's own lint, and its `packages/core/test/lib/effect.ts` for Group's test helper; t3code's
  `tsconfig.base.json` for Group's compiler settings.

Code brought in verbatim keeps its copyright line and licence beside it. Effect, OpenCode and t3code
are MIT; Zalando's guidelines are CC BY 4.0, so text from them is credited and marked as changed.
