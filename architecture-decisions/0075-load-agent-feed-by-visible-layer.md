---
status: accepted
date: 2026-07-24
supersedes: ADR-0074
---

# Load the agent feed by visible layer

## Context and Problem Statement

ADR-0074 brought the Agent feed source into AgentDesk, but copied its eager project digest and
persistent cache along with it. The first screen needs only project identity and recency, while
session activity and transcript events become useful only after navigation selects their parent.

## Decision Drivers

- The projects screen must not read transcript bodies or build event indexes.
- Claude and Codex sessions must group correctly by an existing canonical directory path.
- Live updates and navigation teardown must have one explicit ownership path.
- A v0 cache must justify its consistency cost with measured latency before it is introduced.

## Considered Options

- **Option A**: Keep one rich cached digest and filter it in the renderer.
- **Option B**: Split inventory, selected-project sessions, and selected-session events into
  visibility-scoped APIs and subscriptions.
- **Option C**: Persist a normalized AgentDesk inventory database.

## Decision Outcome

Chose **Option B**. Codex inventory comes from unarchived rows in the highest
`state_N.sqlite`; Claude inventory comes from bounded headers of top-level session JSONL files.
Both sources canonicalize only existing `cwd` directories with `realpath`, and the canonical path is
project identity. The sidecar keeps only the current source catalog, active visibility
subscriptions, and indexes for open sessions. It has no persistent cache or rename ledger.

The loopback API exposes separate project, project-session, and session-event resources. Every SSE
stream starts with a complete snapshot and emits complete replacement snapshots. Swift opens and
closes those streams as a transport adapter. React owns navigation visibility and replaces a parent
watch with its selected child watch. Protocol version `15` makes `source` plus `sessionId` mandatory
for every thread, older-page, raw-event, unsubscribe, and terminal-context message, and adds generated
subscription IDs to project and project-session pushes.

### Consequences

- Good, because first-project delivery is proportional to indexed source metadata rather than total
  transcript content.
- Good, because late pushes and same-ID cross-source collisions are rejected by explicit identity.
- Good, because leaving a screen releases its derived data and event index.
- Neutral, because reopening a project probes its session headers and bounded tails again.
- Bad, because a sidecar restart rebuilds the live catalog and an upstream rename is invisible until
  Claude or Codex reports the new `cwd`.

### Confirmation

Unit tests cover canonical grouping, source-scoped session identity, on-demand indexing, and
visibility teardown. `just agent-feed-sidecar-smoke` verifies one-shot APIs plus live project and
session SSE replacement snapshots. Structured logs report source startup, snapshot duration,
response bytes, subscribers, and zero project-layer transcript body reads. `just check` verifies the
Swift, wire, web, and sidecar contracts together.

## Links

- ADR-0020
- ADR-0060
- ADR-0074
- `SPEC.md` Agent feed contract
