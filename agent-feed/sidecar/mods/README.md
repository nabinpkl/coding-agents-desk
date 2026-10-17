# Claude Code mods

Mods are Claude Code plugins whose hooks module runs inside the session. They live beside the
sidecar because the sidecar is what launches Claude sessions for Bots. Nothing here is installed:
a session loads a mod for its own lifetime with `claude --plugin-dir <dir>` (or, for a probe,
`THROWAWAY_PLUGIN_DIRS`), and nothing is written under `~/.claude`.

A mod imports its own files by relative path, which Claude Code requires, so the repository's
`@/` alias rule does not reach this directory; the fitness gate scans `src/` only.

## prompt-guard

A mod that calls `$.prompt.submit` starts a turn, and Claude Code puts no turn or budget limit on an
interactive session: a mod submitting from `turn.complete` started a turn about once a second until
something stopped it (measured on 2.1.301, 2026-10-16). Escape is the only built-in brake; after it,
Claude Code refuses every mod's prompt until the person types.

`prompt-guard` sees every mod's prompt, because each one arrives as a `prompt.submit` event naming
the mod that sent it, and drops the ones past its limits (`hooks/guard.js`):

- 3 prompts per session since the person last typed there, in the pane, the panel or through
  Remote Control; typing lets mods send again
- one at a time per session. Claude Code holds a mod's prompt until the running turn ends, and
  the guard sees it only as it enters, so prompts that queued up are judged one by one as they go in
- 6 per session and 20 per machine in an hour, counted across every mod
- the same text twice within 10 minutes
- `/pause-mod-prompts` and `/resume-mod-prompts`, for every session on the machine

It fails closed for mods and never stands between the person and their own prompt. Peer messages
and task notices are not mod prompts and are left to Claude Code's own guards.

## The check

`bun mods/checkModPrompts.ts` (from `agent-feed/sidecar`) runs `claude plugin validate` on each mod
here and fails one that calls `$.prompt.submit` while hooking a per-turn event (`turn.*`, or the
settings hooks' `Stop` and `SubagentStop`). It flags timers for a person to read, since it cannot
see what a timer does. Run it on any mod before loading it.
