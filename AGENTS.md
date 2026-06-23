# Load these first

**At session start, and again after any context compaction, read these files if they are not already in context. Do not skip. Do not assume they are loaded.**

1. `/Users/dev/projects/atc/taste/library/universal-AGENTS.md` cross-cutting worker rules. Authoritative for voice, scope discipline, output format, coding rules, and how to write for other agents.
2. `/Users/dev/projects/atc/taste/library/iteration/TASKS-MD-Guidelines.md` the shape of `TASKS.md` for any iteration that opens.

These files do not live in this repo. They are referenced by absolute path from the canonical location. If a path no longer resolves, stop and surface the failure instead of inventing rules.

After loading, acknowledge to the user that you loaded them.

# What this file is for

`AGENTS.md` carries **how to operate inside this repo**: conventions, where things live, how decisions get recorded, how work is broken down. It does **not** carry product intent or implementation shape. Those have their own homes:

- **`PRD.md`** what we are building and why. Source of truth for scope, non-goals, and the v0 acceptance test.
- **`SPEC.md`** how v0 is built. Stack, module boundaries, wire shapes, performance budgets.
- **`AGENTS.md`** (this file) how to work in the repo.

Before doing project work, read `PRD.md` and `SPEC.md` once. They are short on purpose.

# Repository layout

- `CLAUDE.md` session-load entry point. Points at this file.
- `AGENTS.md` this file. Operating rules.
- `PRD.md` product intent.
- `SPEC.md` technical shape for v0.
- `README.md` external-facing one-pager. Points at `PRD.md`.
- `architecture-decisions/` one ADR per decision. `TEMPLATE.md` is the starting shape; `README.md` documents the index and lifecycle.
- `mock-design/` Claude Design HTML/CSS/JS handoff bundle. **Reference for visual feel, not a v0 implementation target.** The mocked agent-native UX (per-agent carousel, reasoning ticker) is v1+, not v0.
- `TASKS.md` (created when the first iteration opens) the iteration ledger, following the guidelines file linked in the load-first section.

# How decisions get recorded

- **Product-level scope decisions** edit `PRD.md`. Keep it short. If the change is large enough that it would invalidate published issues, note that in the commit and link the affected issues.
- **Technical decisions that lock something in** write an ADR under `architecture-decisions/`. The first ADR (ADR-0001) records the stack choice in `SPEC.md`. Update `SPEC.md` to reference the ADR by number.
- **Per-iteration plan and progress** go in `TASKS.md`. Do not duplicate ADR or PRD content there.
- **Anything inferable from reading the code** does not need a doc. Skip the ADR.

# How work is broken down

- The unit of work is a **vertical-slice issue** on GitHub (`nabinpkl/agent-desk`). Each slice cuts through capture, transport, input, and UI as needed to demo or verify end-to-end.
- Slices are labelled `hitl` (requires the human) or `afk` (an agent can ship it without intervention). AFK issues also carry `ready-for-agent`.
- v0 slices are issues #2 through #10. #2 (S0) and #10 (S8) are HITL. The rest are AFK. Dependency edges live in each issue's "Blocked by" section, not here.
- New work appends new issues. Closed issues stay as history.
- Huge feature work goes through `TASKS.md` and a subagent flow. The main agent acts as coordinator and reviewer: it decomposes the plan into concrete R-tasks, delegates bounded exploration, implementation, and review work to subagents where the harness exposes them, integrates the results, resolves conflicts, updates `TASKS.md`, verifies with `just check`, then commits and pushes each green task cluster.

# Conventions

## Voice

- Postmortem voice. State what is, what was decided, what failed. No marketing tone, no hedging, no rhetorical questions for the reader.
- No em-dashes. Use commas, periods, or "and".
- No emoji.
- Avoid AI tells ("As an AI...", "I hope this helps", "Certainly!").

## Scroll and slide direction

The iPhone client uses the **opposite of Mac native** for any horizontal slide or scroll that moves between desktops, by default. Concretely: sliding the finger from left to right moves the active desktop right-to-left, i.e. brings the left-neighbour desktop into focus. The Mac-native mapping (finger right = right-neighbour) is the opt-in mode, exposed as a toggle in settings. This default is load-bearing for the rest-state metaphor "the strip is a scrollbar of desktops": dragging the strip right pulls the previous desktop into the indicator, the same way dragging a scrollbar right pulls earlier content into view.

When in doubt about which direction a code path should produce, the test is: finger left should commit "next" (right-neighbour), finger right should commit "previous" (left-neighbour), under the default toggle.

## Code

- No hardcoded configs. URLs, credentials, tokens, and `~/`-rooted paths go through a central config module, never inline in random files.
- `.env` is gitignored by reflex. If you create one, gitignore it before the first commit.
- Iteration over compatibility. Until v0 ships, breaking changes are free. After v0, breaking changes require an ADR.
- Tests are written for **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView** (see `SPEC.md` for why these five). `SpacesProvider`'s smoke test runs against the live SkyLight binding and is the canary for private-API surface drift across macOS versions. Other modules get tests when a bug demands one.
- Domain glossary terms (`Space`, `Display`, `NormalizedInput`, `DesktopState`, `SessionToken`, `PairingPayload`) are stable. Renames require an ADR.

## Versioning

The two iOS/macOS version fields are independent by design; do not conflate them.

- **Marketing version** (`CFBundleShortVersionString`, `x.x.x`) is the user-facing **semver** label. Bump it **per release, not per build**: MAJOR for an incompatible change, MINOR for a new feature, PATCH for a bug fix. The recurring mistake is leaving it pinned across several distinct shipped changes, so the rule is: **before any TestFlight upload that ships a change, bump the marketing version** (fix -> patch, feature -> minor). It lives in one place (`client_marketing_version` in the `Justfile`); edit that, do not hardcode versions in Info.plist.
- **Build number** (`CFBundleVersion`) is an independent incrementing integer with no relationship to the marketing version. It is the git commit count (`git rev-list --count HEAD`), which auto-increments per upload and maps to a commit. App Store requires it to be numeric and strictly increasing, so a hex sha cannot live here.
- **Exact build identity** is the short git sha, embedded via the `AgentDeskGitSHA` Info.plist key (injected as a build setting) and shown in-app (host popover footer, client unpaired screen). A build reads as `v1.2.0 (380) f0c24cf`: semver version, build number, commit.
- **Host and client version independently.** They are separate apps on separate release cadences (the Mac host is local, the iOS client ships via TestFlight); a host change does not require a client bump or vice versa. The compatibility contract between them is the **wire protocol, not the app version**: a breaking wire change is governed by an explicit protocol version negotiated at the handshake (advertise supported versions, agree on one or fail with a clear "update required"), bumped only on breaking changes. Matching marketing versions across host and client is not a compatibility signal and must not be relied on as one.
- History: `1.1.0` = Mac-initiated pairing (ADR-0019); `1.2.0` = live tailnet device discovery (R55).

## Agent-run device sessions

- When an agent launches the physical iPhone for exploratory media, transport, scroll, decode, or gesture feel work, use an attached console launch by default: `just iphone-console-run`.
- Do not use `just fresh-install` or `just pair-iphone` for exploratory feel runs unless the user explicitly asks for a plain install or a non-attached launch.
- The attached console path is load-bearing because it writes iPhone-side owned-media diagnostics to `/tmp/agentdesk-client-console.log`, including packet repair, stale skips, decoder recovery, render gaps, and frame age.
- For physical-device media regressions, preserve host logs and attached client logs in the same run. Host-only logs are not enough to judge motion behavior.
- When collecting host unified logs from an agent shell, invoke `/usr/bin/log` explicitly. Do not run bare `log`, because zsh can resolve that as the shell builtin and fail with `too many arguments`.

## ADRs

- Filename: `NNNN-kebab-case-title.md`. Numbers never reuse.
- YAML frontmatter carries `status` (`proposed`, `accepted`, `deprecated`, `superseded by ADR-NNNN`).
- Accepted ADRs are immutable. To change a decision, write a new ADR that supersedes it and cross-link both.
- Reference ADRs by `ADR-NNNN` in `TASKS.md`, `SPEC.md`, and code comments. Never by path.

## Commits and PRs

- Small, scoped commits. One slice per PR where possible.
- Commit messages explain the **why**, not the **what** (the diff already shows the what).
- Do not skip hooks (`--no-verify`) or bypass signing unless explicitly asked.
- **Auto-commit and push every meaningful change.** A meaningful change is a complete logical unit (one R-task, one sub-task, one ADR, one slice of a refactor) where `just check` is green. Bundle the doc, code, and test changes for that unit into one commit and push to `origin/<branch>` immediately. The standing authorization is this bullet; do not wait for per-commit permission. WIP states, broken builds, and exploratory half-diffs stay uncommitted. If something is genuinely risky (force-push, history rewrite, destructive operation), still confirm first per universal-AGENTS.md.

# Open questions agents should escalate, not invent

- Bundle IDs and signing identity (HITL, lives in S0).
- Apple Developer Program account details (HITL).
- Anything that would change the v0 acceptance test in `PRD.md` (the 7-day daily-driver criterion).

If you find yourself about to pick one of those on the user's behalf, stop and surface it instead.


# Need to revisit
  - http://localhost needs an ATS exception (NSAllowsLocalNetworking)
  since the app isn't sandbox-exempt for cleartext HTTP.
