---
status: partially superseded by ADR-0068
date: 2026-07-22
partially-superseded-by: ADR-0068 (selection may change source dimensions; local fit and crop stand)
---

# Crop terminal viewports below a readable scale

## Context and Problem Statement

ADR-0066 gives every viewer the same manager-owned logical terminal grid and makes physical layout a
client-local concern. Always fitting that complete grid into a very small window keeps all cells
visible, but eventually makes terminal text unreadable. A minimum native window size avoids that
failure only on one macOS surface and prevents the user from arranging smaller terminal windows.

## Decision Drivers

- One session must retain one logical grid across every macOS and iOS viewer.
- Passive layout and focus changes must never resize the PTY.
- Text must remain readable when a physical viewport becomes smaller than the full fitted grid.
- The active command line must remain visible as output moves the parser cursor.

## Considered Options

- **Always full-fit**: keep scaling the complete logical canvas to any physical size.
- **Enforce minimum native sizes**: prevent each terminal container from becoming too small.
- **Fit, then crop**: full-fit down to a readable scale floor, then clip a cursor-following viewport.

## Decision Outcome

Chose **fit, then crop**. Every shared SwiftTerm renderer scales the complete authoritative canvas to
fit while the required scale is at least 75 percent. Below that threshold, it holds the canvas at 75
percent, clips overflow inside the local container, and follows the parser cursor with a two-cell
inset. The viewport updates after layout, checkpoint completion, live output, local terminal output,
and font changes. It does not depend on the viewer becoming focused or key.

The crop origin and scale are presentation-only state. They do not alter the manager grid, PTY size,
revision, checkpoint, or any other viewer. Standalone macOS terminal windows have no application-set
minimum size. AppKit and UIKit use the same transform, with platform coordinate orientation handled at
the cursor adapter.

### Consequences

- Good, because terminals can occupy arbitrarily small native windows without shrinking text past the
  chosen readability floor.
- Good, because the active cursor remains visible as an unfocused viewer receives output.
- Good, because all viewers still render the same manager-owned rows and columns.
- Bad, because a sufficiently small viewport shows only part of the shared terminal grid.
- Neutral, because explicit logical resize remains the only operation that changes the PTY grid.

### Confirmation

Shared transform tests verify the scale floor, crop bounds, stable origins, inverse coordinate mapping,
and cursor following without a window or focus. The visible terminal replay harness verifies that a
standalone terminal can be smaller than the former minimum while retaining the shared logical grid.

## Pros and Cons of the Options

### Always full-fit

- Good, because the entire logical grid is always visible.
- Bad, because text becomes unusably small in narrow panes and windows.

### Enforce minimum native sizes

- Good, because a single standalone window can preserve text size.
- Bad, because it constrains layout, does not generalize to embedded panes or iOS, and makes native
  window policy responsible for terminal rendering.

### Fit, then crop

- Good, because it applies consistently to every client without changing the shared grid.
- Good, because the crop can follow terminal state without focus.
- Bad, because off-screen terminal content requires cursor movement or a later viewport control to see.

## Links

- SPEC terminal protocol section
- ADR-0066 bounded terminal replay and shared logical grid
