---
status: accepted
date: 2026-07-10
---

# AgentDesk owns the agent workspace

## Context and Problem Statement

AgentDesk already owns the long-lived macOS host, authenticated iOS session, Spaces control, ATC sidecar, and PTY multiplexer bridge. The sibling `agent-workspace-ide` owns a useful workspace sidebar, top bar, file tree, and editable WebKit viewer, but keeping it as a second product leaves workspace state and user-facing control split across two applications. The iOS client also needs direct workspace file access, which cannot have an authoritative home while the Mac workspace shell remains outside AgentDesk.

## Decision Drivers

- One macOS process must own workspace roots, local file editing, terminal sessions, ATC activity, and the authenticated iOS projection.
- The existing AgentDesk Spaces, PTY, ATC, pairing, and transport implementations must remain authoritative instead of being duplicated from the donor application.
- macOS and iOS presentations must share workspace and file contracts without attempting to share AppKit and UIKit view classes.
- File access from iOS must be constrained to registered workspace roots and must reject stale writes.
- Workspace roots and filesystem authority are host-only domain concerns; shared packages carry presentation behavior or wire contracts, not ambient host path access.
- `agent-workspace-ide` is being retired, so new shared ownership cannot remain there.

## Considered Options

- **Option A**: Absorb the workspace model, AppKit shell, file viewer, and required terminal packages into AgentDesk as focused modules, then retire `agent-workspace-ide`.
- **Option B**: Keep both applications and add cross-process APIs so AgentDesk can borrow the workspace shell and file service.
- **Option C**: Put shared UI packages in `agent-workspace-ide` and make AgentDesk continue depending on the retiring repository.

## Decision Outcome

Chose **Option A**. AgentDesk becomes the authoritative single-user agent workspace. The macOS host remains an `LSUIElement` menu-bar application and composes the workspace shell at launch. The host owns workspace persistence and local editable file windows. The iOS client receives workspace-relative file access over a dedicated authenticated reliable stream and renders its own Files surface. Agent activity uses a reusable AgentPanel surface with a direct local ATC adapter on macOS and the existing QUIC-backed adapter on iOS.

Workspace persistence and filesystem authorization remain host-local rather than becoming a general shared domain package. `AgentDeskWire` carries workspace summaries and file request/response DTOs. Host file access walks beneath an already-open registered-root descriptor with no-follow semantics; reconstructed absolute paths and post-resolution prefix comparisons are not authorization boundaries. File revisions are content digests.

The migration takes donor concepts, not the donor application wholesale. AgentDesk keeps its existing Spaces provider, PTY process supervision, ATC sidecar, pairing, and transport. Debug Browser, Jupyter, Dock enrichment, and duplicate Desktop switching from `agent-workspace-ide` do not move in this iteration.

### Consequences

- Good, because workspace state, files, terminals, agents, and remote access have one authoritative owner.
- Good, because the iOS Files surface can enforce host workspace boundaries instead of exposing arbitrary filesystem paths.
- Good, because the retiring repository stops being the long-term home of code required by AgentDesk.
- Bad, because AgentDesk expands from a remote-control utility into a larger workspace application and must keep strict internal module boundaries.
- Bad, because adding the files stream is a breaking wire change and requires protocol version 6.
- Neutral, because AppKit and UIKit remain separate presentations over shared models and transport contracts.

### Confirmation

- `AgentDeskHost` starts the workspace sidebar and top bar while remaining an `LSUIElement` application.
- AgentDesk persists workspace roots under its bundle-scoped Application Support directory and imports the existing AWI store once.
- Local macOS file editing preserves conflict-aware save behavior.
- The paired iOS client can list, read, edit, and revision-check files only under registered workspace roots.
- The macOS Agents surface reads the host-owned ATC sidecar directly, while the iOS Agent surface continues through the authenticated session.
- No production AgentDesk target imports a source package from `agent-workspace-ide` after donor retirement.

## Links

- `PRD.md` v0 user surface
- `SPEC.md` Module Boundaries and Wire Shapes
- ADR-0030 single QUIC session transport
- ADR-0035 phone-side agent-feed observability
- ADR-0050 shared wire package
- ADR-0051 remote SwiftTerm terminal
