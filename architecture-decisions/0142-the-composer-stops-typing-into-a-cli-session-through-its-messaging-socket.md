---
status: accepted
date: 2026-10-17
supersedes: ADR-0107
---

# The composer stops typing into a CLI session through its messaging socket

## Context and Problem Statement

ADR-0107 let the panel's composer type into a Claude Code session running in a terminal by writing
a turn to the harness's own per-session messaging socket: one `auth` line with the session's peer
key, one `user` line. Two things changed. The harness frames every turn that arrives on that socket
as a message from another session ("not from your user", with none of the user's authority), so a
turn the owner typed into the panel reached the model as a peer's words. And sending needed the
session's messaging key, read out of `~/.claude/sessions`, which is Claude Code's own registry.
Meanwhile the session a reader types into is nearly always one the panel launched in a tmux pane,
which the mirrored composer (`useTmuxComposer`) already types into as the person at the keyboard,
and hub messages now reach a session through the `agentdesk-hub` mod. Touches
`agent-feed/wire/cliSession.ts` (was `cliInput.ts`), `sidecar/src/input/claudeCliSession.ts` (was
`claudeSessionInbox.ts`), `sidecar/src/http/session-routes/cliSessionRoutes.ts` (was
`cliInputRoutes.ts`), the panel's `features/cli-input/useCliSession.ts` (was `useCliInput.ts`) and
the session composer.

## Decision Drivers

- What the owner types reaches the model as the owner's own words, or does not go.
- Nothing of Claude Code's is read that is not needed: its messaging key is a credential to that
  session.
- A terminal session keeps its place in the composer order, so the window composer is still not
  probed for it and its pane mirror still attaches when the reader reaches for the field.

## Considered Options

- **Remove the socket send and keep a read-only status**: the panel still learns whether a session
  is a terminal CLI process and in which pane, from the verified registry row alone.
- **Keep the socket send for sessions outside tmux**: the only way to type into a Claude CLI that
  agent-desk did not launch.
- **Remove the status too**: let a terminal session fall to the window composer, whose resolver
  refuses a terminal chain.

## Decision Outcome

Chose **remove the socket send and keep a read-only status**. Keeping the send fails the first
driver: a turn on that socket is a peer's message by the harness's own framing, whatever the panel
calls it. Removing the status fails the third: the window composer would be probed for every
terminal session, and the band that attaches the pane mirror would go with it.

A terminal session now gets, in order: its tmux pane's mirrored composer once that attaches; an
already-open Agent Feed terminal; otherwise a band that sends nothing, holds the draft locally,
attaches the mirror when focused, and hands the draft over when it does. Once the pane has been
looked for and not found, that band is disabled and says the session runs outside a tmux pane.

### Consequences

- Good, because the owner's typing reaches a session only as typing, at its own keyboard.
- Good, because the sidecar no longer reads any session's messaging key, and holds no code that
  writes to a session's socket.
- Bad, because a Claude CLI that agent-desk did not launch in a tmux pane can no longer be typed
  into from the panel. Starting or resuming it from the panel puts it in a pane.
- Neutral, because the status route moved from `GET /api/sessions/claude/:id/input` to
  `GET /api/sessions/claude/:id/cli`, and `POST` on the old path is gone.

### Confirmation

`app/terminalSessionComposer.test.tsx` asserts the band sends nothing and posts nothing under
`/api/sessions/claude/`, hands its draft to the pane's composer once the mirror attaches, and says
so when there is no pane. `cliSessionRoutes.test.ts` asserts the old delivery route falls through.
