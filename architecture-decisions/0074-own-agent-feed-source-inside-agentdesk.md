---
status: accepted
date: 2026-07-24
supersedes: ADR-0035
---

# Own the agent feed source inside AgentDesk

## Context and Problem Statement

ADR-0035 established the local WebKit feed, host loopback sidecar, and authenticated iOS bridge, but
left both authored components in the sibling ATC repository. A clean AgentDesk checkout therefore
could not build or evolve its Agents surface without an unrelated repository whose browser,
orchestration, worker, and dashboard systems were outside AgentDesk's product scope.

## Decision Drivers

- One checkout must contain every authored input required to build AgentDesk.
- Raw Claude and Codex transcripts remain authoritative in their native directories.
- UTF-8 byte indexing, truncation recovery, watcher checkpoints, digest construction, and live tailing
  must remain one tested ingestion boundary.
- AgentPanel should own its authored Vite source next to the Swift package that embeds its generated
  resource.
- ATC browser, worker, tmux, canvas, dashboard, and observed-project state must not enter AgentDesk.

## Considered Options

- **Option A**: Copy the useful source into purpose-named AgentDesk components and let the copies
  evolve independently.
- **Option B**: Extract a third shared package consumed by both repositories.
- **Option C**: Keep configurable paths to the sibling ATC checkout.

## Decision Outcome

Chose **Option A**. `packages/AgentPanel/Web` owns the React/Vite renderer and bridge datasource.
`agent-feed/sidecar` owns Claude/Codex discovery, normalization, byte indexing, digest construction,
and the five host-consumed HTTP/SSE routes. The host compiles and bundles
`agent-feed-sidecar`, gives it a bundle-variant-scoped Application Support directory, and continues
to bridge its loopback output to the authenticated iOS session. There is no compatibility alias,
fallback path, subtree link, or synchronization mechanism back to ATC.

### Consequences

- Good, because a clean AgentDesk checkout builds the complete Agents surface.
- Good, because stable and dev hosts no longer share `~/.atc` cache state.
- Good, because browser automation and orchestration code are absent from the bundled sidecar.
- Neutral, because AgentDesk now owns maintenance of its Claude and Codex transcript adapters.
- Bad, because fixes made independently in ATC do not flow into AgentDesk automatically.

### Confirmation

`just check` runs the AgentPanel TypeScript tests and the sidecar parser/index/watcher tests.
`just agent-feed-sidecar-smoke` compiles the bundled binary and verifies `/api/config` plus the
project digest over loopback. Repository search must find no build path or environment override that
references the sibling ATC checkout.

## Links

- ADR-0035
- `SPEC.md` AgentPanel and host component sections
