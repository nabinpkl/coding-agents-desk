# Dependency exceptions

Accepted deviations from the dependency bar, with why and when to revisit.

## minimumReleaseAge exclusions (web/pnpm-workspace.yaml)

**Date:** 2026-07-22

**What.** `minimumReleaseAgeExclude` in `web/pnpm-workspace.yaml` exempts a set of
packages from the global pnpm `minimumReleaseAge` (48h) supply-chain cooldown.

**Why.** The web app pins the latest stable Next 16. The Next 16.2.11 release
wave (2026-07-21) bumped Next and a large slice of its transitive tree
(`@next/*`, `@tanstack/*`, `@typescript-eslint/*`, `browserslist`, `postcss`,
`jose`, `prettier`, `electron-to-chromium`, `enhanced-resolve`,
`baseline-browser-mapping`, `own-keys`, `systeminformation`). All of them were
published inside the 48h window, so the cooldown rejected the lockfile even
though nothing was reinstalling — the audit runs on every `pnpm install` and on
`next dev` startup. Without the exclude, `just dev` / `pnpm dev` fail until the
versions age out, and the only workarounds are downgrading the whole toolchain
or disabling the cooldown globally.

**Risk accepted.** Newly published versions of the listed packages install
immediately, so a compromised just-published version of one of them would not be
delayed by the cooldown. Bounded: every listed package is mainstream and
human-maintained, and the cooldown stays fully enforced for every other
dependency.

**Revisit trigger.** On the next dependency bump, prune this list: drop any
transitive one-off (`browserslist`, `postcss`, `jose`, `prettier`,
`electron-to-chromium`, `enhanced-resolve`, `baseline-browser-mapping`,
`own-keys`, `systeminformation`) whose pinned version is now older than 48h — it
no longer needs exempting. Keep the fast-releasing direct lines (`next`,
`eslint-config-next`, `@next/*`, `@tanstack/*`, `@typescript-eslint/*`,
`typescript-eslint`) only as long as they keep cutting releases faster than the
window.
