---
status: accepted
date: 2026-07-23
---

# Reconcile workspace assignments after Mission Control

## Context and Problem Statement

Workspace Desktop assignments retain a stable SkyLight Space ID plus display and display-local
ordinal presentation metadata. macOS posts an active-Space notification for ordinary Desktop
switches, but Mission Control can reorder, move, create, or delete Desktops without changing the
active Space. AgentDesk therefore needs a bounded way to discover completed topology edits without
continuously polling private APIs or guessing that an old ordinal still names the same Desktop.

## Decision Drivers

- A surviving assignment must follow its exact Space when Mission Control moves or reorders it.
- A deleted or temporarily unavailable Space must remain unresolved instead of selecting a different
  Space occupying the same display and ordinal.
- Idle host work must remain event-driven; polling is acceptable only during an active Mission
  Control interaction.
- All affected assignments must persist atomically through the existing `WorkspaceCoordinator`.
- AgentDesk must not require an installed yabai daemon or alter any network protocol.

## Considered Options

- **Continuously poll Space topology.** Read and compare managed display Spaces for the host lifetime.
- **Depend on yabai.** Subscribe to or query an installed yabai daemon for Mission Control changes.
- **Mirror yabai's host-local observation seam.** Register current-macOS Dock accessibility entry
  notifications plus legacy SkyLight event `1204`, check the unnamed layer-18 Dock window every
  100 ms only until Mission Control exits, then read topology once.
- **Keep ordinal fallback.** Continue treating display plus ordinal as a substitute identity when a
  saved Space ID is absent.

## Decision Outcome

Choose the **host-local yabai-style observation seam** and make **Space ID the sole identity**.
`MissionControlTopologyObserver` registers its process-lifetime entry sources once. On current macOS,
yabai observes the Dock's `AXExposeShowAllWindows`, `AXExposeShowFrontWindows`, and
`AXExposeShowDesktop` notifications; older macOS uses SkyLight event `1204`. AgentDesk registers both
sources so the installed OS behavior is covered, and coalesces duplicate entry events into one
observation epoch. While Mission Control remains visible, one main-queue check is scheduled every
100 ms; no timer runs while it is closed. At exit, the observer reads user Spaces once, grouped by
display and ordered by display-local ordinal, and emits only when that topology differs from its last
snapshot.

The workspace shell resolves surviving Space IDs to their new display and ordinal, submits all
changes through one coordinator mutation, then refreshes workspace badges, monitor markers, Dock
enrichment, and active-workspace reconciliation. Assignments whose Space IDs are absent are left
unchanged and render unresolved. Workspace lookup and switching never fall back to display plus
ordinal.

### Consequences

- Good, because workspace identity survives Mission Control reordering and cross-display movement.
- Good, because deleted or startup-missing Spaces cannot silently route a workspace to another
  Desktop.
- Good, because private polling is bounded to an observed Mission Control interaction and no yabai
  installation is required.
- Bad, because this depends on undocumented Dock accessibility notifications, SkyLight event `1204`,
  and Dock window-layer behavior that can drift with macOS.
- Neutral, because unresolved assignment metadata remains durable until the user explicitly
  reassigns that workspace.
- Neutral, because the existing active-Space notification remains responsible for ordinary Desktop
  switching.

### Confirmation

- Observer tests pin registration failure, duplicate entry coalescing, observation epochs, 100 ms
  rescheduling, exit detection, restart without duplicate registration, and absence of idle polling.
- Topology tests cover same-display reorder, cross-display movement, creation, deletion, and
  fullscreen/application-Space filtering.
- Workspace tests pin strict Space-ID matching, unresolved retention, stale-switch refusal, and one
  immutable coordinator publication for a multi-assignment reconciliation.

## Links

- ADR-0054 Share the workspace and files data model.
- ADR-0055 Port the Dock-enrichment strip with one SkyLight source.
- [yabai Mission Control source](https://github.com/koekeishiya/yabai/blob/v7.1.25/src/mission_control.c) (inspected 2026-07-23).
- [yabai OS-specific registration source](https://github.com/koekeishiya/yabai/blob/v7.1.25/src/yabai.c) (inspected 2026-07-23).
- [yabai bounded exit checks](https://github.com/koekeishiya/yabai/blob/v7.1.25/src/event_loop.c) (inspected 2026-07-23).
- `SPEC.md`
- `TASKS.md`
