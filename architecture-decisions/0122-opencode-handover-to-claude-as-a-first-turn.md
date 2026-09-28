---
status: accepted
date: 2026-09-28
---

# Opencode sessions hand over to Claude as one first-turn argv

## Context and Problem Statement

ADR-0119 sends a compacted Claude session's context to a new opencode session as one rendered
prompt. The reverse was asked for next, and it is not the same problem with the nouns swapped: the
source has no transcript to read and the destination has no API to call.

Reading changes because opencode sessions are the serve's, not a file's (ADR-0116), so the event
index -- which is what numbers a transcript and is typed to file-backed sources -- cannot answer for
them. Writing changes because Claude has no create-session endpoint at all: `ClaudeLiveBackend` is
registered but read-only and throws on `createSession` and `send`. A Claude session is a tmux pane.

## Decision Drivers

- The render, its caps and its refusals are already decided in ADR-0119 and should not be decided
  twice.
- `MAX_LAUNCH_PROMPT` is 32,768, and a real handover exceeds it: measured on this project's own
  compacted transcripts, the rendered prompt is 21,751 and 67,781 characters.
- The mapper caps text at 8,000 characters for the feed, and a real compaction summary runs 16KB to
  28KB, so the summary ADR-0119 leaves uncapped would arrive cut by a third to two thirds.
- A session created and never prompted is the failure ADR-0119 built its single route around.

## Considered Options

- **The rendered handover as the CLI's positional first turn**, on the existing
  `startClaudeSession` path.
- **A file the new session is told to read**, with a short pointer as the first turn.
- **Typing it into the pane** after starting the session.

## Decision Outcome

Chose **the positional first turn**, because the size objection to it turned out to be measured
rather than assumed and it is not there. `kern.argmax` is 1,048,576 bytes; after the double shell
quoting on the way into tmux, the larger of the two real handovers is 68,891 bytes, 6.6% of the
budget. That kills the file option on cost rather than taste: a file adds a location to choose, a
sweep to run, a permission surface to prove and a retention policy to hold, and buys nothing at the
sizes that occur. Typing it in walks into the `send-keys -l` silent-drop, which is already written
down.

Create-plus-first-prompt is literally one argv here, so this direction cannot strand a session even
in principle, which is the property ADR-0119 needed a single route to construct.

Two bounds follow. The prompt is capped at 256KB, a quarter of argmax, and refused above it with
`handover-too-large` rather than left for `posix_spawn` to answer with E2BIG inside tmux. That cap
is deliberately not `MAX_LAUNCH_PROMPT`: 32,768 bounds a brief somebody TYPED, and loosening it
would loosen it for the case it was written to catch.

The summary is read from the raw serve message rather than from the mapped row, so the feed's
8,000-character cap does not reach the one part of a handover that states what the reader is
looking at. Everything else -- which turns, which caps, which refusals -- comes from the rendering
`sessionHandover.ts` already does, now taking events rather than a session so both directions share
it.

### Consequences

- The successor runs where the source runs, never in a worktree: a handover continues work rather
  than branching it.
- Images and structured tool results are not carried, the same as the forward direction.
- Codex is a source in neither direction. It has no compaction boundary to cut at, so there is
  nothing to state what the successor is looking at.
- The same render answers a read: `GET /api/sessions/:source/:sessionId/handover` returns the
  summary and the turns since it without starting anything, for either source. One reader backs
  all three routes, because a read that offers a summary the start then refuses is worse than
  either refusing on its own.
- A handover is cut at the newest LANDED compaction. The serve writes a checkpoint when compaction
  starts and flips it on landing, and a retry compacts the same session under a new message, so
  cutting at a running or aborted one would carry a summary still being written.

### Files

- `agent-feed/sidecar/src/transcripts/opencodeHandover.ts`
- `agent-feed/sidecar/src/transcripts/sessionHandover.ts`
- `agent-feed/sidecar/src/http/agent-routes/handoverRoutes.ts`
- `packages/AgentPanel/Web/src/features/bots/sessionHandover.ts`
- `packages/AgentPanel/Web/src/features/bots/dialogs/HandoverDialog.tsx`
