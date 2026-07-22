# AgentDesk alacritty_terminal fork

This directory contains only the `alacritty_terminal` crate from Alacritty v0.17.0.

- Upstream: https://github.com/alacritty/alacritty
- Revision: `94e7c8874e526b1e67b349d9ba30ddf81669119e`
- Crate version: `0.26.0`
- Imported: 2026-07-22

AgentDesk carries one intentional source change: `Term::replay_grids()` exposes immutable primary
and alternate grid references plus read-only tab-stop and scroll-region state so the PTY manager can
serialize a complete late-join checkpoint. The upstream `Term::grid()` API exposes only the currently
active grid.

Before updating, replace the crate from a tagged upstream release, reapply that single accessor,
and run this crate's tests plus the PTY manager replay tests.
