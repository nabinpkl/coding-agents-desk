---
status: accepted
date: 2026-09-23
---

# Claude sessions hand over to opencode as one rendered prompt

## Context and Problem Statement

A Claude session that ran out of context holds its past in a megabyte transcript the reader wants
continued in opencode. Opencode's serve owns its sessions behind an HTTP plus SSE API with no
history-injection endpoint: the only write path is a user prompt. The handover must cross that
gap without stranding state and without a second copy of either store.

## Decision Drivers

- No native history import exists: `session.create` takes only parent, title and directory, and
  `session.fork` stays inside one opencode session.
- The serve stays the durable record (ADR-0116): no writing rows into its SQLite, no second client
  beside the SDK path.
- Person and model prose is the signal; tool outputs are facts that must survive in capped form.
- The panel must never strand a created-but-never-prompted session between two calls.

## Considered Options

- **Single user turn carrying the rendered handover**: summary plus post-compaction turns as prose,
  tool calls collapsed, sent as the new session's first prompt.
- **Direct SQLite row insertion**: native roles preserved, but bypasses serve events, fights the
  WAL lock, and repeats the drift ADR-0116 rejected.
- **Two panel calls (create, then send)**: strands a session on any failure between them.

## Decision Outcome

Chose **single user turn** because it is the only write path the serve offers, which kills the
SQLite option on supportability rather than taste, and one sidecar route owns create plus first
prompt, which kills the stranded-session option structurally. The prompt carries a provenance
prefix, the compaction summary uncapped, post-boundary turns uncapped, tool inputs and outputs
head-plus-tail capped with line-collapse inside each call, and the reader's message last.

### Consequences

- Tool results arrive as quoted text, not structured results: the model gets the facts but
  resumes no tool calls, and images are not carried.
- Claude only: any other source is rejected, so Codex support is a new branch rather than a
  silent fallback.
- A handover without a compaction is refused: there is no summary to state what the reader is
  looking at.

### Files

- `agent-feed/sidecar/src/transcripts/sessionHandover.ts`
- `agent-feed/sidecar/src/http/agentRoutes.ts`
- `packages/AgentPanel/Web/src/features/bots/dialogs/HandoverDialog.tsx`
- `packages/AgentPanel/Web/src/app/shell-state/useBotCommands.ts`
- `packages/AgentPanel/Web/src/features/bots/menus/SessionRowMenu.tsx`
