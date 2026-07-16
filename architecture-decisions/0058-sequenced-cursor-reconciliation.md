---
status: accepted
date: 2026-07-16
---

# Sequenced cursor reconciliation with explicit host provenance

## Context and Problem Statement

The iPhone renders cursor movement immediately from a local prediction while the macOS host applies the same input asynchronously. The existing `CursorPositionPush` does not distinguish delayed feedback from an iPhone-originated move and a cursor move initiated independently on the Mac. A delayed host position can therefore rewind the client prediction before a later update moves it forward again, and the client has no trustworthy signal for showing that its prediction is unconfirmed.

## Decision Drivers

- Delayed feedback for an older iPhone input must never rewind a newer client prediction.
- Cursor movement initiated on the Mac must remain authoritative and reconcile on the iPhone.
- A client prediction that the host does not confirm must become visibly unconfirmed instead of continuing to look authoritative.
- Transport ordering alone must not stand in for OS-application acknowledgement or movement provenance.

## Considered Options

- **Option A**: Treat any recent host position as confirmation and use a timeout for ghost presentation.
- **Option B**: Mark each host position as remote feedback or host-local movement without sequencing remote inputs.
- **Option C**: Sequence client cursor inputs, acknowledge the applied revision, and send host-local movement as a distinct message carrying the last applied client revision.

## Decision Outcome

Chose **Option C**. Each client `cursorSet` or `cursorMove` carries a monotonically increasing cursor revision. The host returns `CursorAppliedPush` only after posting that input and returns independently observed Mac movement as `HostCursorMovedPush`. The latter carries the last client revision applied for that session. The client keeps unacknowledged cursor operations, never applies an acknowledgement older than its latest prediction as a visible correction, and rebases host-local movement before replaying any newer pending operations.

The client presents revisioned inputs to the QUIC stream through one main-actor task chain. The host presents all feedback frames to its side of that stream through one channel-owned send chain. QUIC preserves bytes in the order supplied, while these application queues guarantee that the call order supplied to QUIC also matches causal order.

The client cursor confidence state is `confirmed`, `awaitingHost`, or `ghost`. The first pending cursor input starts one confirmation deadline. New input does not extend the oldest unconfirmed deadline. Applied-revision progress removes acknowledged operations; catching up to the newest revision restores `confirmed`. Send failure, channel absence, or deadline expiry enters `ghost`. Cursor-image updates do not confirm position.

### Consequences

- Good, because delayed acknowledgements can advance confirmation without pulling the displayed cursor backward.
- Good, because independently observed Mac movement remains authoritative while newer client intent is replayed on top.
- Good, because the grey ghost cursor represents a protocol fact rather than a transport-age heuristic.
- Bad, because cursor input and feedback become a breaking wire change and require AgentDesk protocol v9.
- Bad, because the client retains a bounded in-memory list of unacknowledged cursor operations until the host catches up or the session resets.
- Neutral, because cursor acknowledgements stay on the existing reliable ordered input stream; the revision expresses application causality, not transport order.

### Confirmation

Wire tests require cursor revisions and distinguish applied from host-local frames. Host dispatcher tests prove the acknowledgement callback runs only after cursor dispatch; session wiring scopes that callback to the originating input channel, whose outbound send chain preserves feedback order. Client reducer tests cover stale acknowledgement, confirmation timeout, ghost recovery, host-local rebase plus replay, duplicate/future feedback, and send failure. UIKit tests pin normal and ghost presentation for both fallback and mirrored cursor modes.

## Links

- ADR-0009
- ADR-0020
- ADR-0030
- ADR-0050
- SPEC `NormalizedInput` and cursor feedback frames
