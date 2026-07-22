---
status: accepted
date: 2026-07-22
supersedes: D91 bind-time resize behavior
---

# Let the persistent PTY manager own bounded terminal replay

## Context

The Rust PTY manager already outlives the AgentDesk host, but terminal display state lived only in
each SwiftTerm client. A host restart, late join, or temporarily slow client therefore produced a
blank or incomplete terminal even when the PTY and child process were still alive. Client view sizes
also resized the shared PTY implicitly, so two viewers could not observe one stable terminal grid.

Persisting raw output or scrollback would expose terminal contents, including secrets, and create an
unbounded storage lifecycle. Replaying an unbounded byte log would still reconstruct the wrong state
after alternate-screen programs, cursor movement, or erasure.

## Decision

Each live Rust session owns one Alacritty terminal core, one logical rows-by-columns grid, and one
revision sequence. PTY output is parsed before publication. Terminal-generated PTY replies are
collected by this one headless owner and written once, so renderers never multiply device replies.

Inner PTY protocol 6 adds chunked ANSI checkpoints. `Attached` and session summaries report dimensions
and revision. Every output batch carries the revision assigned after headless parsing. Attach, explicit
checkpoint request, slow-client recovery, and explicit logical resize produce bounded begin/chunk/end
checkpoints. Clients accept live output only after a complete checkpoint and only at the next revision.

The terminal core is a narrow vendored `alacritty_terminal` fork pinned to Alacritty 0.17.0 commit
`94e7c88`. The fork exposes immutable normal and alternate grids because the inactive grid is private
upstream. The GUI is not vendored. Licenses, revision marker, tests, and the diff audit stay with it.

Operational state is bounded: 64 sessions, 16 clients per session, a 512 by 256 maximum logical grid,
2,000 scrollback lines, 16 MiB checkpoints, 512 KiB chunks, bounded client/event/writer queues, and
64 KiB inputs. Old history is dropped before mandatory visible buffers. A mandatory screen that cannot
fit fails explicitly. Bitmap terminal graphics are excluded.

SwiftTerm establishes the authoritative grid before replay, suppresses parser replies only while
applying manager data, and maps interaction through a local fit transform. Passive AppKit/UIKit layout
never resizes the PTY. A shared size control is the only UI that sends logical resize.

Standalone macOS terminal windows persist presentation metadata only: presentation id, PTY session
name, optional workspace id, frame, cascade ordinal, and label. Launch restoration reattaches only to a
running persistent session, constrains the frame to current displays, and orders without focus. Explicit
close or session exit removes the descriptor; host shutdown preserves it. Terminal bytes, cells,
scrollback, ANSI, checkpoints, and typed input never enter durable storage or logs.

The outer AgentDesk session protocol remains 13 because the terminal lane stays opaque.

## Consequences

- Current and late clients converge on one logical grid and revision.
- State survives host restart while the Rust manager survives, with no disk history or replacement shell.
- Differently sized macOS and iOS views fit the same grid locally.
- Slow transport costs bounded replacement checkpoints, not unbounded memory or forced disconnect.
- Sixel, Kitty, and other bitmap replay need a later state model.

Relates to ADR-0051, ADR-0053, ADR-0056, and ADR-0061.
