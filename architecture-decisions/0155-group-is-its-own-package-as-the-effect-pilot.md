---
status: accepted
date: 2026-10-25
---

# Group is its own package, the pilot for Effect, with its own compiler settings, lint and tests

## Context and Problem Statement

Group, the group chat tab and its server process (`docs/plans/group-chat.md`), is built on Effect v4
to standards set before its first line: the `group-effect` and `group-api-design` skills, after
t3code and OpenCode. Its home was first set inside the sidecar package
(`agent-feed/sidecar/src/group/`), with its standards layered over the sidecar's by oxlint overrides.
Measured on 2026-10-25, that layering fights the sidecar's own settings in four places, and every
fight is decided by the sidecar's history rather than by Group's standards. This decides where
Group's code, compiler settings, lint and tests live. It touches `agent-feed/`, `.oxlintrc.json`,
the `justfile`'s gate and `tools/agent-feed-fitness.sh`.

## Decision Drivers

- Group's standards hold from its first file, with no exception granted because the sidecar does
  something else (`docs/agents/group.md`).
- A rule's outcome for a file is read in one place, not worked out from the order of overlapping
  overrides.
- Group's tests run on the runtime Group runs on, Bun, because its stop and restart behaviour was
  measured there (U5, U6, U8, U9 in the design doc).
- Group is the pilot for Effect in the sidecar: what it proves should move as a whole, not be
  unpicked from the sidecar's configuration.
- Every check reaches Group's code on every `just check`.

## Considered Options

- **Option A**: Group inside the sidecar package at `agent-feed/sidecar/src/group/`, its rules as
  oxlint overrides and ast-grep rules scoped to that directory.
- **Option B**: Group as its own package, `agent-feed/group/`, with its own `package.json`,
  `tsconfig.json`, `.oxlintrc.json`, ast-grep rules and tests, and a gate leg of its own.
- **Option C**: Option B with vitest and `@effect/vitest` as its test runner, as t3code does.

## Decision Outcome

Chose **Option B**, with `bun test` and an Effect helper adapted from OpenCode, because it is the
only option in which each of the four measured fights is decided by Group's standards:

1. **Lint.** oxlint gives a rule the options of the last override that matches a file, and check 8
   passes `-c`, which turns off nested config files (oxc.rs, "Nested configuration files",
   2026-10-25). A Group test file matched three overrides (sidecar, sidecar tests, Group), and
   Group's, being last, silently replaced the test override's import bans. In its own package,
   Group's `.oxlintrc.json` is run on its own and the root config never sees Group's files.
2. **Compiler settings.** A tsconfig covers its whole program. t3code's
   `exactOptionalPropertyTypes` gives 108 errors in 53 files of the existing sidecar, so Group could
   not have it inside the sidecar without clearing them first.
3. **Effect's type-aware checker.** `@effect/tsgo`, which supports the TypeScript 7.0.2 both use,
   patches the `typescript` package in `node_modules` to report its diagnostics from `tsc`. In the
   sidecar that is the compiler of the whole sidecar; in its own package, only Group's.
4. **Tests.** `@effect/vitest` fails under `bun test` (it needs vitest's runner internals, which
   Bun's shim lacks), and the sidecar's `bun test --parallel` would pick up Group's test files.

Option A is knocked out by all four. Option C is knocked out by the runtime driver: vitest runs on
Node unless started with `bun --bun`, and a second runner beside the sidecar's buys nothing that
OpenCode's 80-line helper over `bun:test` (`packages/core/test/lib/effect.ts`, MIT) does not give:
`it.effect` on a TestClock, `it.live` on the real clock, and `testEffect(layer)`. Adapted to Group's
imports, it ran a TestClock test on Bun 1.3.13 and Effect 4.0.6, and a failing Effect failed its
test.

What each source contributes: t3code the shape of the code and its compiler settings; OpenCode the
package layout, the test helper and the ast-grep rules; the sidecar the rules it learned, copied
into Group's own lint config rather than inherited through overrides, the React rules left out and
the ban on timers in tests extended to all of Group's code. The repository's own rules (file and
directory caps, imports by absolute path, formatting, the public scan) apply to Group as to the
other live trees.

### Consequences

- Good, because each of Group's rules is read in one file, and the sidecar's and the panel's
  configuration never needs a Group exception.
- Good, because Group can take compiler settings and checkers the sidecar cannot yet, and the
  sidecar can later move to Effect by taking Group's package configuration as it stands.
- Good, because Group's tests run under the same runner and runtime as the sidecar's.
- Bad, because Group needs a gate leg, its paths in the fitness checks and the formatter, and a
  supervised process of its own: wiring the sidecar's position got for free.
- Bad, because the lint rules Group shares with the sidecar are copied, so a lesson added to one is
  not in the other until it is copied too.
- Neutral, because this is the third home recorded for Group on one day, each from a measurement
  the one before lacked; the design doc's "Where Group lives" keeps the history.
- Neutral, because whether the panel imports Group's contract for a typed client, and with it
  Effect, is left for later.

### Confirmation

- The `agent-feed-group-check` leg typechecks and tests the package whenever a path under
  `agent-feed/group/` changes, and `just check-legs` runs it always.
- Check 8 of `tools/agent-feed-fitness.sh` runs oxlint with `agent-feed/group/.oxlintrc.json` over
  Group's sources, and Group's ast-grep rules over them; checks 5 to 7 cover `agent-feed/group/src`.
- The root `.oxlintrc.json` has no override for Group, and bans the sidecar from importing Group or
  Effect.

## Links

- `docs/plans/group-chat.md`, "Where Group lives" and "How the kernel is built"
- `docs/agents/group.md`, the `group-effect` and `group-api-design` skills
- OpenCode `packages/core/test/lib/effect.ts`, t3code `tsconfig.base.json` and
  `docs/internals/effect-services.md` (`.reference/`, both MIT)
- https://oxc.rs/docs/guide/usage/linter/nested-config.html (read 2026-10-25)
