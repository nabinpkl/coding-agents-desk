---
status: accepted
date: 2026-07-17
---

# Swap Dock desktop contents through yabai

## Context and Problem Statement

Dock enrichment already groups windows by stable macOS Space ID through the host's single SkyLight reader (ADR-0055). It now needs to exchange the ordinary window contents of two existing Desktops without changing Space identity, order, or workspace assignment. macOS has no public API for moving arbitrary third-party windows between Spaces, while yabai already provides that operation on this machine without its scripting addition.

## Decision Drivers

- Dock selection must continue to use stable Space IDs because Desktop indices can change after display topology updates.
- A partial swap must roll back rather than leave the two Desktops in an unknown mixed state.
- The UI must not parse process output, invoke a shell, or gain direct window-management authority.
- Existing SkyLight ownership and iOS wire contracts must remain unchanged.

## Considered Options

- **Option A**: Move windows with public Accessibility APIs.
- **Option B**: Add private SkyLight window-placement calls beside `SpacesProvider`.
- **Option C**: Isolate yabai behind a typed, transactional host adapter.

## Decision Outcome

Chose **Option C**. Dock selection passes stable source and destination Space IDs to a host-only transaction executor. The executor resolves current yabai Space indices immediately before action, captures both eligible window sets, moves and verifies them, and reverses completed moves on failure. Undo restores only captured windows still at their expected swapped destination, so later user movement is never overwritten.

The eligible set contains non-minimized, non-hidden, non-sticky, non-native-fullscreen windows assigned to either selected Space. Yabai's `is-visible` field is not an eligibility signal because windows on an inactive Space report false. The executable path and command timeout come from central host configuration. Commands use `Process` directly, never a shell.

### Consequences

- Good, because Space reading remains in `SpacesProvider` while external mutation has one replaceable adapter.
- Good, because stable IDs cross the UI boundary and volatile indices exist only inside one transaction.
- Good, because rollback, verification, and conservative Undo make partial failure explicit.
- Bad, because the host feature depends on a separately installed and Accessibility-authorized yabai executable.
- Neutral, because this swaps window contents rather than Space identities, labels, or ordering.

### Confirmation

Host tests decode real-shaped yabai JSON and pin filtering, stable-ID resolution, move order, verification, rollback, and conservative Undo. Dock state-machine and AppKit tests pin selection, cancellation, busy state, Undo expiry, keyboard activation, and accessibility identifiers. Live verification queries window IDs before and after Swap and Undo.

## Links

- ADR-0001
- ADR-0054
- ADR-0055
- SPEC `DockDesktopSwapExecutor`
