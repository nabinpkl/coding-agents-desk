---
status: accepted
date: 2026-08-02
---

# Restore every standalone tool window through one Desktop placement authority

## Context and Problem Statement

The macOS `＋ Agents` and `＋ Terminal` commands created independent windows, while Workspace IDE was a singleton and the three surfaces restored different amounts of state. AppKit normally creates a window on the active Space, so frame-only persistence cannot return a window to the display and Desktop where it was left.

## Decision Drivers

- A `＋` command means a new independent window instance.
- Host restart must reconstruct every still-open instance without stealing focus or changing the active Space.
- Space identity, display topology repair, and verification must not diverge across IDE, Agents, and Terminal.

## Considered Options

- Keep separate feature-specific frame and Space restoration code.
- Let AppKit restore frames and accept the currently active Space.
- Share placement values and one host WindowServer coordinator while each feature owns its descriptors and runtime state.

## Decision Outcome

Choose one shared `DesktopWindowPlacement` value and one `DesktopWindowPlacementCoordinator`. Each feature registry owns UUID-keyed descriptors, per-window state, creation, user-close removal, and termination preservation. The coordinator alone captures exact Space membership, repairs a stale Space ID from display-local ordinal, moves a hidden window, and verifies the result before it is revealed. New windows appear on the Desktop that issued the command without activating the daily-driver menu-bar app; restart restoration uses non-key ordering and never moves a window to the active Space.

### Consequences

- Good, because all three window families now follow the same Desktop and lifecycle contract.
- Good, because IDE local state and terminal layouts are isolated by window UUID.
- Bad, because exact restoration depends on private WindowServer APIs and must fail visibly when those APIs drift.
- Neutral, because the feature registries retain separate persisted schemas for their distinct local state.

### Confirmation

Pure placement tests cover exact Space restore, display-local ordinal repair, and verification failure. Registry tests cover independent creation, per-Desktop cascade, user-close deletion, termination preservation, and unfocused restart reconstruction.

## Links

- PRD acceptance item 16
- SPEC Host component 32
