# Dependency exceptions

## xterm.js 6.0.0

- Evaluated: 2026-07-22
- Pinned revision: `f447274f430fd22513f6adbf9862d19524471c04`
- Official release: https://github.com/xtermjs/xterm.js/releases/tag/6.0.0, released 2025-12-22
- Repository: https://github.com/xtermjs/xterm.js

xterm.js is the maintained terminal renderer used by VS Code and has more than 20,000 GitHub stars,
but its latest stable release is seven months old at evaluation time. That misses this repository's
usual recent-release heuristic. AgentDesk accepts the gap because xterm is the established browser
terminal implementation, release 6.0.0 includes current ESM and IME work, and no newer maintained
alternative provides the required WebKit input, selection, accessibility, and rendering surface.

AgentDesk vendors a narrow fork exposing user-provenance data without forwarding parser replies. The
upstream license, exact revision, fork tests, and diff audit live under `terminal/vendor/xterm`.

Revisit when xterm publishes a newer stable release, the fork can be replaced by an upstream public
user-only input event, a maintained compatible fork emerges, or a security advisory affects the pinned
revision. Remove the dependency if upstream maintenance stops or WebKit support regresses.
