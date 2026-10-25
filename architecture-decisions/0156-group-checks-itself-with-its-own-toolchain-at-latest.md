---
status: accepted
date: 2026-10-25
---

# Group checks itself with its own toolchain, at each tool's latest release

## Context and Problem Statement

ADR-0155 made Group (`agent-feed/group/`) a package with its own compiler settings, lint and tests.
As first built, its lint, type checker for lint, formatter and ast-grep still ran from the panel
package's `node_modules` in the fitness leg, and its TypeScript and `@types/bun` were pinned to
match the sidecar's. The owner's direction on 2026-10-25: Group's package is independent of the
other packages' dependencies, and takes its dependencies at their latest. This also decides how
Effect's type-aware checks (`@effect/tsgo`) reach the gate. It touches Group's `package.json`,
`bunfig.toml`, `tsconfig.json`, the `justfile`'s `agent-feed-group-check`, and checks 8 and 9 of
`tools/agent-feed-fitness.sh`.

## Decision Drivers

- A Group change is checked by tools Group chose, at versions Group chose, so upgrading the panel's
  lint never moves Group's and the reverse.
- Group, as the Effect pilot, tracks Effect and its tooling as they ship: `@effect/tsgo` released
  almost daily in October 2026.
- Effect's mistakes that `tsc` passes are caught before review: measured 2026-10-25, a probe of
  nine (an Effect never run, a leaked service requirement, a returned Effect in a generator,
  `Effect.runSync` inside an Effect, a plain `Error` failure, merged layers that depend on each
  other, `Date`, `console`, `process.env`) typechecked cleanly and `@effect/tsgo` reported all nine.

## Considered Options

- **Option A**: Group keeps using the panel's oxlint, tsgolint, oxfmt and ast-grep in the fitness
  leg, and adds `@effect/tsgo` alone.
- **Option B**: Group's package owns every tool its checks use, as exact-pinned dev dependencies at
  their latest releases, and its gate leg runs them all; the fitness leg keeps only the
  repository's dependency-free checks for Group.
- **Option C**: Option B with `@effect/tsgo`'s patch mode, which rewrites the installed
  `typescript` so `tsc` reports Effect's diagnostics.

## Decision Outcome

Chose **Option B**. Group's dev dependencies are TypeScript, `@effect/tsgo`, oxlint and
oxlint-tsgolint, oxfmt and `@ast-grep/cli`. `agent-feed-group-check` runs, from Group's own
`node_modules`: the typecheck, `effect-tsgo diagnostics --strict`, oxlint with Group's
`.oxlintrc.json` and the ast-grep rules, oxfmt with Group's `.oxfmtrc.json` (the repository's one
setting, 120 columns), and `bun test`. Group's `bunfig.toml` sets `minimumReleaseAge = 0`, the
owner's call, so its dependencies are taken at their latest; each is still pinned exactly, so none
moves without a commit. Fitness checks 5 to 7 (file and directory caps, imports by absolute path)
and the public scan still cover Group, since they read files, not dependencies; checks 8 and 9 no
longer read it, and the pre-commit hook asks its formatting of the panel's and the sidecar's files
only.

Option A is knocked out by the first driver: the panel's tools would set Group's versions. Option C
is knocked out by the cost of rewriting a package in `node_modules`, which every reinstall undoes,
when the standalone command checks Group's seven files in 0.3 s.

Effect's checks run with severities set in the tsconfig's plugin block rather than left to the
defaults, which leave several at suggestion; `unstableApiUsage` is off, because every HttpApi module
is marked unstable and Group accepts that by pinning Effect. `@types/bun` follows the Bun that runs
Group, not the latest types: types for a newer Bun would typecheck calls the running one lacks.

### Consequences

- Good, because Group's checks and their versions are read in Group's package alone.
- Good, because Effect's own mistakes fail the gate, and the first run found two in Group's code (a
  global `fetch` in the test helper's network stand-in, now excused with its reason, and a plain
  `Error` in a failure channel, now a tagged `NetworkRefused`).
- Bad, because Group installs its own copy of each tool, `@effect/tsgo`'s binary alone 171 MB.
- Bad, because taking releases without a wait gives up the protection the wait exists for: a
  release pulled within a day of publishing reaches Group first. Exact pins and provenance
  (`@effect/tsgo` and its macOS binary carry SLSA provenance) are what is left.
- Neutral, because Group's lint and formatting now run only when a path under `agent-feed/group/`
  changes, which is the only thing that can change their result.
- Neutral, because ADR-0155's Confirmation named check 8 for Group's lint; that check is now the
  `agent-feed-group-check` leg, and ADR-0155's decision stands.

### Confirmation

- `agent-feed-group-check` fails on a probe for each tool: an oxlint rule (including a type-aware
  one), an Effect diagnostic, and a formatting difference, shown on 2026-10-25.
- `agent-feed/group/package.json` lists every tool the leg runs, and the leg names no path outside
  the package except the shared dependency installer.

## Links

- ADR-0155, which this refines
- `agent-feed/group/AGENTS.md`, the `group-effect` skill ("What the gate enforces")
- https://github.com/Effect-TS/tsgo (read 2026-10-25)
