---
status: accepted
date: 2026-06-30
---

# Phone-side agent-feed observability surface fed by an embedded engine sidecar

## Context and Problem Statement

The sibling ATC project's durable value is observability of coding-agent work (combined Claude and Codex threads per project), not its orchestrator/worker model. This decision folds that observability into the AgentDesk iPhone client as a read-only agent surface: the author watches how agents are building a project, and scrolls crisp agent output, from the phone, without switching apps. It touches the host (`host/AgentDeskHost/`), the client (`client/AgentDeskClient/`), the QUIC session input lane, and the build/distribution pipeline. Design spec: `docs/superpowers/specs/2026-06-30-agent-feed-mobile-surface-design.md`.

## Decision Drivers

- Reuse the durable asset (ATC's transcript normalization) rather than reimplementing it; avoid two copies of Claude/Codex parsing drifting apart.
- Native text crispness and scroll fidelity on the phone, consistent with the project thesis.
- One transport and one trust boundary: do not add a second authenticated network surface to the phone.
- Single source of truth: the raw transcripts stay authoritative; nothing caches a second copy of agent history.
- Read-only first: no write path back into a live agent session in this iteration.

## Considered Options

- **Option A**: Embed ATC's engine as a compiled Bun sidecar under the host; bridge its normalized output onto the existing QUIC input lane; render in the client by reusing ATC's React components in a local `WKWebView`.
- **Option B**: Port ATC's Claude/Codex readers to Swift in the host; render with a native iOS markdown stack.
- **Option C**: Point a `WKWebView` at ATC's dashboard served over HTTP from the Mac over Tailscale.

## Decision Outcome

Chose **Option A**. Option C was rejected by the one-transport/one-trust-boundary driver: it adds a second authenticated network surface (the dashboard has no auth today) and is a remote web app, against the crispness thesis. Option B was rejected by the reuse driver: porting the Codex SQLite plus rollout parsing and the digest aggregation duplicates roughly 1600 lines of hot-path logic and incurs permanent drift maintenance as transcript formats change. Option A reuses ATC's normalization wholesale, keeps one authenticated transport (the QUIC session input lane), and renders real text at native DPR in a local `WKWebView` (data injected over the bridge, never fetched), which is crisp, not the mushy video-of-text that motivated the native client. A spike confirmed `bun build --compile` produces a single ~64MB standalone binary that serves the needed endpoints on loopback.

The sidecar is host-internal: it binds loopback only (`ATC_HOST=127.0.0.1`) and is never exposed to the phone. The host bridges between the sidecar's loopback HTTP/SSE and the phone's QUIC input lane.

### Consequences

- Good, because the agent feed reuses ATC's battle-tested normalization and ATC's React rendering, so there is one observability codebase across the desktop dashboard and the phone.
- Good, because no new phone-facing transport or trust boundary is introduced; the feed rides the already-authenticated session input lane.
- Bad, because the notarized host DMG now embeds and must sign and notarize a ~64MB Bun-compiled binary, and the host build depends on the ATC engine source as a build input.
- Neutral, because the feed is viewable only while a remote-control session is live in this iteration; a session-independent channel is left to a later arc.

### Confirmation

The wire types carry round-trip codec tests on both host and client (`AgentFeedWireTests`). `AgentEngineSidecar` carries a lifecycle test, and `just sidecar-smoke` runs the real compiled binary under host supervision and confirms it serves combined Claude plus Codex project digests on loopback. The single-source-of-truth rule is observable: the host holds no persistent agent-history store; it reads the sidecar, which reads the raw transcripts.

## Pros and Cons of the Options

### Option A (embedded Bun sidecar + WKWebView reuse)

- Good, because it reuses ATC's normalization and rendering with no reimplementation.
- Good, because data rides the existing authenticated QUIC lane; one transport, one trust boundary.
- Bad, because it embeds, signs, and notarizes a large binary and couples the host build to the ATC repo.

### Option B (Swift port)

- Good, because the host stays single-language with no embedded runtime and one code signature.
- Bad, because it duplicates roughly 1600 lines of parsing/aggregation and pays permanent drift maintenance.

### Option C (remote dashboard in a webview)

- Good, because it is the least implementation work.
- Bad, because it adds an unauthenticated second network surface and ships a remote web app against the crispness thesis.

## Links

- SPEC: session input lane wire shapes; ADR-0030 (single QUIC session transport)
- `docs/superpowers/specs/2026-06-30-agent-feed-mobile-surface-design.md`
- PRD (scope reopened from "Not agent-native" to include the read-only agent feed)
- ATC project: `~/projects/atc` (ATC ADR-0004 project world-context timeline)
