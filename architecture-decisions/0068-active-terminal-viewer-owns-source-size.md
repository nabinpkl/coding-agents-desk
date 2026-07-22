---
status: accepted
date: 2026-07-22
supersedes: ADR-0066 (explicit manual sizing only), ADR-0067 (selection never changes source dimensions only)
---

# Let the last active terminal viewer own the source grid size

## Context and Problem Statement

ADR-0066 made one Rust-owned headless grid authoritative for every viewer, while ADR-0067 kept that
grid readable in smaller clients through local fit and crop. The remaining explicit global size
control made ordinary window and pane layouts awkward: a selected viewer did not naturally receive
the rows and columns its viewport could display, and changing the shared size required a separate
manual action.

A generic PTY still has only one authoritative rows-by-columns source at a time. Independently
reflowing the same live PTY for multiple clients would create divergent cursor positions, alternate
screens, wrapping, and application state rather than two views of one terminal.

## Decision Drivers

- Every client must receive the same authoritative grid, revision, checkpoint, and live output.
- The selected or interacted-with viewer should use its native terminal capacity without requiring
  keyboard focus or a manual size control.
- Passive layout changes in an inactive viewer must not disturb the active viewer or the PTY.
- Ownership and viewport state must remain bounded, authenticated, memory-only session state.
- Host restoration must reopen windows without stealing application focus or terminal ownership.

## Considered Options

- **Fixed global grid**: keep one manually selected rows-by-columns size for every viewer.
- **Independent per-client grids**: parse or reflow one PTY stream into a different terminal state for
  every client.
- **Last-active viewer ownership**: keep one grid and let the last selected or interacted-with active
  viewer choose its dimensions.

## Decision Outcome

Chose **last-active viewer ownership**. Inner PTY protocol 7 replaces explicit `Resize` with
sequence-fenced `TerminalViewerState` reports and targeted `TerminalViewportStatus`. The manager
derives viewer identity from its assigned socket client id. A valid claim records that active viewer
as owner. A passive report updates only cached capacity, except that a passive report from the current
owner applies its changed dimensions. Keyboard input and paste claim with the sender's latest valid
capacity before the bytes reach the PTY.

Each session serializes owner changes, PTY resizing, headless resizing, checkpoint publication, and
output. An owner change with equal dimensions advances only the ownership epoch. A different owner
capacity resizes the PTY and headless grid once, advances the terminal revision once, and checkpoints
every client. Releasing the owner promotes the most recently activated remaining active viewer. With
no active viewer, the manager retains the final grid and continues bounded headless rendering.

Shared AppKit and UIKit terminal content measures native cell capacity, ignores transient zero-sized
layouts, trails owner resizing by 150 milliseconds, and flushes on completed resize, selection, or
input. Selection, window activation, pointer or touch interaction, keyboard input, and paste can
claim without requiring SwiftTerm to be first responder. Hidden, deselected, backgrounded, detached,
or closed views release participation; losing application focus alone does not. Restored standalone
windows attach active but do not claim until selected or interacted with.

Followers keep ADR-0067's local presentation: fit the owner's grid while readable, hold the 75 percent
scale floor, crop below it, follow the parser cursor, inverse-map interaction, and fill all uncovered
space with the terminal background. The manual global size control is removed. Ownership, reported
viewport capacity, terminal contents, and checkpoints are never persisted.

### Consequences

- Good, because the terminal automatically adopts the currently used viewer's real capacity.
- Good, because inactive viewers cannot resize the PTY merely by changing physical layout.
- Good, because all clients still converge on one grid and revision and bounded replay remains intact.
- Bad, because followers show the owner's wrapping and may need local fit, crop, or padding.
- Neutral, because two viewers cannot simultaneously receive independent PTY reflow without becoming
  different terminal states.

### Confirmation

Protocol and manager tests cover claims, passive reports, stale sequences, invalid dimensions,
same-size and different-size transfer, input-before-write claiming, fallback, and no-owner freezing.
Shared renderer tests cover measurement, zero-layout suppression, release, status, fit, crop, and
inverse mapping. The visible terminal replay harness opens two differently sized clients, transfers
ownership without first-responder focus, verifies passive and owner resizing, claims through follower
input, and restores windows without focus or ownership theft.

## Links

- SPEC terminal PTY protocol and PTY session lifecycle sections
- ADR-0066 bounded Rust-owned replay and metadata-only restoration
- ADR-0067 readable client-local fit and crop
