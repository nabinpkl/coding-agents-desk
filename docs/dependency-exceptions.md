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

## web-push 3.6.7

- Evaluated: 2026-10-19
- Pinned version: `web-push@3.6.7` (with `@types/web-push@3.6.4`), in `agent-feed/sidecar`
- Last release: 3.6.7 on npm, 2024-01-16
- Repository: https://github.com/web-push-libs/web-push

Fails the recent-release and human-maintenance checks: no release in 21 months, and the last ten
merged PRs are dependabot bumps apart from one human docs PR (2026-09-11). Accepted on the owner's
word under the fixed-standard allowance: it implements RFC 8030 (push), RFC 8291 (payload
encryption) and RFC 8292 (VAPID), none of which has moved, and it is the well-known implementation
(3.5k stars, about 6.8M weekly downloads, not archived, no deprecation banner). No OSV advisory
against it, and `bun audit` reports nothing in its dependency tree at evaluation time.

Only `agent-feed/sidecar/src/push/pushSender.ts` imports it, so it can be swapped for a hand-rolled
WebCrypto sender without touching callers. Revisit on a successor to any of those RFCs, a push
service (Apple, Google) rejecting what it sends, an advisory against it or a dependency, or the
repository being archived.
