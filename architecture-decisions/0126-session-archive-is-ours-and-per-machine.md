---
status: accepted
date: 2026-10-11
---

# Archiving a session is ours, kept per machine beside bots.json

## Context and Problem Statement

A reader wants to file a session away so it stops appearing on the Canvas, in Bot rosters and in
the Sessions list, without deleting anything. Claude has no archive of its own. Codex has one, an
`archived` column in its state database, which `transcripts/catalog/codexCatalog.ts` already reads
to leave archived threads out. The question is where an archive this panel sets lives, what it
hides, and when it is allowed.

## Decision Drivers

- Write nothing Claude owns, and nothing in a provider's store: the panel is a viewer of other
  tools (AGENTS.md, "Claude's own files are read-only").
- Every surface on one machine -- the Mac, the phone, a second host tier -- must agree.
- Archived must never hide work in progress.
- Undo has to be visible: a hidden session with no way back is lost to a reader who forgot.

## Considered Options

- **Option A**: a sidecar-owned `session-archive.json` beside `bots.json`, one per machine.
- **Option B**: browser storage in the panel.
- **Option C**: each provider's own flag (Codex's column; a transcript record for Claude).

## Decision Outcome

Chose **Option A**. Option B fails agreement: the phone and the Mac would hold two answers, which
is the reason Bot canvas arrangement moved into `bots.json` (AGENTS.md, "Panel state"). Option C
fails the first driver: Claude has nothing to set without writing its transcript, and Codex's
database is read-only to us.

The rules that come with it:

- **Refused while running.** Claude by `sessionOwner` in `tasks/sessionRegistry.ts`, which checks
  the pid against its start time; every other source by its backend's live bin. Not by a stamped
  tmux pane, which outlives the agent. 409 `session-running`. Unarchive is never refused.
- **Hidden everywhere.** The catalog carries `archivedAt` on every row. Bot views leave archived
  sessions out entirely (neither shown nor missing), and the reference stays on the Bot so
  unarchiving puts the session back where it was. The panel splits archived rows off in
  `subscribeInventory`, the one place every inventory reader goes through.
- **Stays archived.** New activity does not bring a session back; only Unarchive does, from the
  per-project "Archived (n)" toggle in the Sessions list.

### Consequences

- Good, because the provider stores are untouched and the archive follows the machine, not the
  browser.
- Bad, because the file is not watched: a change written by another sidecar sharing it shows on
  this one's next change or restart. The directory it shares with `bots.json` is watched and
  unwatched by the Bot store, which under Bun is the pattern that leaves the next watch on a path
  inert (AGENTS.md, "a watch you close poisons the NEXT watch").
- Neutral, because a session Codex itself archived is still absent from the catalog altogether, so
  it never reaches this toggle; the two archives do not meet.

### Confirmation

`sessionArchive.test.ts` and `sessionArchiveRoutes.test.ts` in the sidecar, the archived case in
`botSessionResolution.test.ts`, and the split in the panel's `contractFixture.test.ts`.

## Links

- `agent-feed/sidecar/src/transcripts/session-ops/sessionArchive.ts`
- `agent-feed/sidecar/src/http/agent-routes/sessionArchiveRoutes.ts`
- `packages/AgentPanel/Web/src/features/sidebar/session-list/ArchivedSessions.tsx`
