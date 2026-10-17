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

## agentdesk-hub

Delivers agent-hub messages into a Claude session as prompts, in place of the development-channel
flag (`docs/agent-messaging.md`, "Delivering into a Claude session through a mod"). It starts the
hub reader (`src/hubReaderMain.ts`) with the session, submits each message one at a time, and
confirms it to the hub through `src/hubConfirmMain.ts` only once the prompt has entered:

- the owner's messages go in as their own words (`asUser`), which `prompt-guard` counts as the
  owner typing; another agent's go in as a plain prompt that says who sent it, that it carries none of the
  owner's authority, and what its kind asks for (a report is weighed, a question answered without
  changes, a request done only inside the owner's task)
- a prompt the guard or Claude Code drops stays here, unconfirmed, and is tried again when the
  person next types; the hub requeues anything unconfirmed if the reader's stream drops
- a message whose prompt already went in is only confirmed if it arrives again, never submitted
  twice
- the reader is started again if it stops while the session lives, and moved to the new id when
  the session id changes

Load it beside `prompt-guard`, and the relay MCP server keeps its tools but opens no stream of its
own when it sees this mod on the session's command line.

What each kind of message asks of the session (`hooks/hubKindWording.ts`) is shared with the
sidecar, which frames opencode prompts with it. It lives here because Claude Code refuses a mod
import from outside the mod's folder; a peer sidecar is shipped that one file and not the mod.

## How sessions get them

Every Claude session the sidecar launches, resumes or forks loads both mods with `--plugin-dir`
from this directory (`config/configClaudeLaunch.ts`; `AGENT_FEED_CLAUDE_MODS=0` turns it off). They
are not installed, so an edit here reloads live in every session holding them. A session started
before a change to that launch is listed as behind it (`launch-flags`), and the Profile menu's
restart brings it onto the current one.

## The check

`bun mods/checkModPrompts.ts` (from `agent-feed/sidecar`) runs `claude plugin validate` on each mod
here and fails one that calls `$.prompt.submit` while hooking a per-turn event (`turn.*`, or the
settings hooks' `Stop` and `SubagentStop`). It flags timers for a person to read, since it cannot
see what a timer does. Run it on any mod before loading it.
