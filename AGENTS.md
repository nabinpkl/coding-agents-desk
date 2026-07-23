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

# How work is done

Workers mode is opt-in. Use it only when the user explicitly asks to use workers mode for the current
task. Do not infer workers mode from task size, complexity, an R-task, or the generic ECC guidance to
delegate proactively. Outside workers mode, the active thread plans, implements, reviews, and verifies
the work itself without spawning workers.

When workers mode is active, major features run through Codex native threads, not a generic subagent
flow. The four standing roles are **Co-ordinator**, **Implementor**, **Reviewer**, and **Small Tasks
Doer**.

- **Co-ordinator** is the main control thread and the only integration owner. It owns the live plan,
  keeps `TASKS.md` current, partitions each coherent phase into ownership lanes, assigns one standing
  Implementor-Reviewer pair to each lane, coordinates contracts and ordering between lanes, verifies
  the integrated tree, and decides when a task cluster is ready to commit and push.
- **Implementor** owns one coherent phase or lane for its duration. It takes that lane's R-tasks in
  sequence, modifies code and tests inside the assigned ownership boundary, runs the stated gates,
  self-reviews the complete diff, and reports exact files changed, verification results, and remaining
  risks. It does not promote the ledger, commit, or push.
- **Reviewer** is the standing independent, read-only reviewer for one phase or lane. It retains the
  lane's context across task reviews and correction rounds, and reviews requirements and complete diffs
  for correctness, regressions, security, lifecycle cleanup, and missing tests. Findings lead the
  response, ordered by severity, with file and line references. It does not patch its own findings.
- **Small Tasks Doer** handles narrow, low-risk chores that do not need decomposition: spelling fixes,
  small doc updates, targeted test additions, mechanical renames, and one-file bug fixes. It does not
  absorb broad feature work or architecture changes.

## Phase-lane implementor-reviewer loop

When workers mode is active, every R-task that changes behavior uses this loop, but thread ownership
persists across the coherent phase or lane. Do not spawn a fresh Implementor or Reviewer for each
R-task. The Co-ordinator mediates all handoffs so task scope, review disposition, cross-lane contracts,
and repository state have one owner.

1. **Partition.** Before implementation, the Co-ordinator divides the phase only where work has
   independent ownership boundaries and can progress without concurrent edits to the same files or
   contracts. It records each lane's ordered R-tasks, dependencies, owned surface, and standing
   Implementor-Reviewer pair in the live plan. Sequential tasks in the same subsystem stay in one lane
   so their pair retains context.
2. **Brief.** The Co-ordinator gives the lane's existing Implementor its next R-task or named sub-task
   with the exact acceptance criteria, allowed surface, relevant paths, required tests, and known
   unrelated dirty files. The brief names dependencies that must already be green and states that scope
   changes return to the Co-ordinator rather than being assumed.
3. **Implement.** The Implementor reads the current files, writes tests and code, runs the task gates,
   then performs the final self-review below. It hands back the commit-ready diff without committing,
   including exact commands and outcomes. A failing or unrun gate is reported plainly.
4. **Review.** The Co-ordinator sends the same task contract and current diff to the lane's standing
   Reviewer. The Reviewer reads the implementation in repository and accumulated lane context, not only
   the patch. No findings means it says so explicitly and records residual test gaps; approval is never
   inferred from silence.
5. **Correct.** The Co-ordinator sends every actionable finding and open question back to the same
   Implementor. The Implementor either fixes it and reruns affected gates, or returns a concrete
   technical disagreement with evidence. It does not silently dismiss or defer findings.
6. **Re-review.** The same Reviewer checks the corrections and the complete task diff again. Steps 5-6
   repeat until no actionable findings remain. The Co-ordinator resolves disagreements; a disputed
   correctness, security, data-loss, or lifecycle finding blocks promotion until resolved or escalated
   to the human.
7. **Integrate the task.** The Co-ordinator checks the actual worktree, runs the task-level gates from
   `TASKS.md` (including `just check`), performs its own final integration review, and only then flips
   the task from R to D. The task code, tests, and ledger transition land in the same commit and are
   pushed immediately under the repo's commit policy.
8. **Continue or close the lane.** The same pair receives the lane's next R-task without re-onboarding.
   After its final task, the Reviewer performs one aggregate phase/lane review against the landed tree,
   and the Co-ordinator runs the phase-level gates and cross-lane integration checks before releasing
   the pair.

Parallel lanes are created and scheduled only by the Co-ordinator. Contract-producing lanes land before
dependent lanes consume them; the Co-ordinator relays contract changes and blocks stale consumers until
they refresh. Do not run Implementor and Reviewer edits concurrently on the same lane. Replace a standing
thread only when it is unavailable, near its context limit, or demonstrably stale, and give the
replacement the full lane contract, landed task history, current diff, review disposition, and next task.

## Final self-review before handoff

Every agent reviews its own completed diff before handing work back to the human or another Codex thread. This is separate from testing and separate from an external Reviewer pass.

The review exists because edits are temporal: the first file changed was written without seeing the middle and last files that would later land. After the full change exists, re-read the diff as one system and fix incoherencies before reporting completion.

Minimum pass:
- Re-open the files touched earliest and check them against the final shape of the later files.
- Check naming, wire shapes, config keys, actor or threading assumptions, lifecycle cleanup, tests, docs, and log messages for cross-file agreement.
- Look for stale assumptions introduced mid-task: duplicated state, old fallback behavior, mismatched comments, tests that assert an earlier design, and docs that describe only part of the final implementation.
- Fix issues found in this self-review before handoff. Do not leave obvious integration cleanup as a note for the human unless it is blocked by missing information or an explicit scope boundary.
- In the final report, state that self-review happened and name any remaining risk.

# Conventions

## Scroll and slide direction

The iPhone client uses the **opposite of Mac native** for any horizontal slide or scroll that moves between desktops, by default. Concretely: sliding the finger from left to right moves the active desktop right-to-left, i.e. brings the left-neighbour desktop into focus. The Mac-native mapping (finger right = right-neighbour) is the opt-in mode, exposed as a toggle in settings. This default is load-bearing for the rest-state metaphor "the strip is a scrollbar of desktops": dragging the strip right pulls the previous desktop into the indicator, the same way dragging a scrollbar right pulls earlier content into view.

When in doubt about which direction a code path should produce, the test is: finger left should commit "next" (right-neighbour), finger right should commit "previous" (left-neighbour), under the default toggle.

## Code

- No hardcoded configs. URLs, credentials, tokens, and `~/`-rooted paths go through a central config module, never inline in random files.
- `.env` is gitignored by reflex. If you create one, gitignore it before the first commit.
- Iteration over compatibility. Until v0 ships, breaking changes are free. After v0, breaking changes require an ADR.
- Tests exxists for **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView** .`SpacesProvider`'s smoke test runs against the live SkyLight binding and is the canary for private-API surface drift across macOS versions. 
- Treat each new feature/debugging arc as scoped by the user's current words, not by the previous arc's implementation surface. Before editing, make the active surface explicit: is the behavior universal across input paths, or limited to a named surface such as video, trackpad, scroll strip, keyboard chrome, or settings? If the user asks for universal behavior, start at the shared model/path and only add narrow recognizer hooks as adapters. For example, "tap/click opens keyboard" is input-model behavior (`GestureTranslator` / `sendInput` / host focus push), not automatically `handleVideoTouchTap`, even if the previous conversation was about video touch.

## Versioning

The two iOS/macOS version fields are independent by design; do not conflate them.

- **Marketing version** (`CFBundleShortVersionString`, `x.x.x`) is the user-facing **semver** label. Bump it **per release, not per build**: MAJOR for an incompatible change, MINOR for a new feature, PATCH for a bug fix. The recurring mistake is leaving it pinned across several distinct shipped changes, so the rule is: **before any TestFlight upload that ships a change, bump the marketing version** (fix -> patch, feature -> minor). It lives in one place (`client_marketing_version` in the `Justfile`); edit that, do not hardcode versions in Info.plist.
- **Build number** (`CFBundleVersion`) is an independent incrementing integer with no relationship to the marketing version. It is the git commit count (`git rev-list --count HEAD`), which auto-increments per upload and maps to a commit. App Store requires it to be numeric and strictly increasing, so a hex sha cannot live here.
- **Exact build identity** is the short git sha, embedded via the `AgentDeskGitSHA` Info.plist key (injected as a build setting) and shown in-app (host popover footer, client unpaired screen). A build reads as `v1.2.0 (380) f0c24cf`: semver version, build number, commit.
- **Host and client version independently.** They are separate apps on separate release cadences (the Mac host is local, the iOS client ships via TestFlight); a host change does not require a client bump or vice versa. The compatibility contract between them is the **wire protocol, not the app version**: a breaking wire change is governed by an explicit protocol version negotiated at the handshake (advertise supported versions, agree on one or fail with a clear "update required"), bumped only on breaking changes. Matching marketing versions across host and client is not a compatibility signal and must not be relied on as one.
- History: `1.1.0` = Mac-initiated pairing (ADR-0019); `1.2.0` = live tailnet device discovery (R55).
- **The Chrome extension versions independently too** (third component, ADR-0038/0042/0043). Its **marketing version is `manifest.json`'s `version`** (semver, and the single source of truth: `manifest.json` is the only place it lives, no Justfile mirror). Bump it **per release, before reloading a build you intend to judge** -- feature -> minor, fix -> patch, same rule as host/client. `version_name` carries an optional human label shown in `chrome://extensions`. Its **exact build identity is the short git sha**, written to a **gitignored `chrome-extension/build-info.json`** by `just ext-stamp` (the extension parallel of the host/client `AgentDeskGitSHA`): an unpacked extension runs whatever is on disk at reload time, so the manifest version alone can't tell you whether you reloaded after an edit -- the sha can. The **toolbar popup footer** shows it as `v0.2.0 (718) 4ba5e8a` (marketing version, commit count, sha), with a yellow **`dirty`** marker when there were uncommitted edits under `chrome-extension/` at stamp time. `ext-stamp` runs automatically inside `dom-bridge-install`, `dom-mirror-record-verify`, and `dom-mirror-e2e`; for a **manual real-Chrome load, run `just ext-stamp` then reload the extension** so the popup and your felt read match the code. Like host/client, the extension's **compatibility with the host is the wire protocol, not its version** (the `dom-batch` envelope + protocol negotiation), so its version is free to move independently. History: `0.2.0` = isolated-world recorder (ADR-0042) + compressed transport (ADR-0043); `0.3.0` = tiered fidelity (ADR-0044): isolated adopted-stylesheet enrichment + opt-in CDP keyframe; `0.7.0` = multi-window projection (ADR-0063); `0.8.0` = visible ordinary page content with password-only source masking (ADR-0041).

## Client build variants

Two client apps can coexist on one iPhone: the **stable** daily-driver (`com.example.agentdesk.AgentDeskClient`) and an **experimental** "dev" build under test (`com.example.agentdesk.AgentDeskClient.dev`, "AgentDesk Dev" name, DEV-ribbon icon). iOS keeps both because they have different bundle ids. This lets risky graphics work be tested on the phone without losing the working app, which protects the 7-day daily-driver acceptance test.

- One target, one scheme. The variant is a build-time override axis, not a duplicated target: the dev build overrides `PRODUCT_BUNDLE_IDENTIFIER`, `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev`, and `BUNDLE_DISPLAY_NAME` inline, and builds into a separate derived-data dir (`{{derived_data}}-dev`).
- The runtime self-namespaces by bundle id: `Config.logSubsystem` and `Config.keychainService` derive from `Bundle.main.bundleIdentifier`, so each variant's os_log lines and keychain are separate.
- The leaf client recipes take a `variant` arg (`stable` default | `dev`): `client-install`, `client-reinstall`, `iphone-console-run`, `pair-iphone`, `iphone-log-collect`, `client-archive-release`, `testflight-upload`. Pass `dev` for the side-by-side AgentDesk Dev build, e.g. `just testflight-upload dev`. The dev bundle id is env-overridable via `AGENTDESK_CLIENT_DEV_BUNDLE_ID`.
- The physical-device feel-run composites are explicit recipes, not arg-driven, because the launch mode matters: `fresh-install` (no console, returns) and `fresh-release-diagnostic-run` (console attached, blocks). The `fresh` prefix is the reinstall; `-install` (no console) vs `-run` (attached console) marks the launch mode. Each has a `-dev` suffixed twin (`fresh-install-dev`, `fresh-diagnostic-run-dev`) that drives the Dev build. All rebuild the host and reinstall the client; the stable pair builds `-configuration Release` (a Debug `-Onone` host pegs a core in the crisp tile codec and distorts the motion you are judging), while the `-dev` twins stay Debug for fast, breakpoint-friendly iteration on risky changes. `host-run` / `host-run-dev` now build the REAL bundled artifacts themselves before the host build — the compiled Bun agent sidecar and the Vite agent webview, plus the gesture/voice webview and the voice-server source — so every launch's phone agent surface serves real projects/threads, not a placeholder, and the composites no longer pre-build them. (The sim counterparts `agent-feed-sim[-pair]` are the Debug-stack sim bring-ups; `sim-fresh-install` is the Release one — both bundle real artifacts now.) There is deliberately no detached-console composite: a backgrounded console grows the log file unbounded with no teardown. For bounded background capture use `motion-verify` (fixed window, then it tears the stream down).
- Both variants register the `agentdesk://` scheme. Dev pairing injects the URL via `devicectl --environment-variables` into a specific bundle id (read in `SceneDelegate`), bypassing system URL routing, so the shared scheme does not affect pairing.

## Host build variants

The Mac host has the same dev/stable split as the client, and the two hosts run **concurrently** on one Mac (ADR-0037). The stable daily-driver is `com.example.agentdesk.AgentDeskHost`; the experimental host is `com.example.agentdesk.AgentDeskHost.dev` (DEV-badged icon, separate derived-data dir `{{derived_data}}-host-dev`).

- Identity is the bundle id, not a flag. `host/AgentDeskHost/Config.swift` derives `logSubsystem`, `launchAgentLabel`, `dispatchQueuePrefix`, `keychainService`, and the Application Support directory (now `~/Library/Application Support/<bundle-id>/`) from `Bundle.main.bundleIdentifier`. Each variant's logs, keychain, launchd registration, and on-disk state are separate.
- Ports are tier-derived (`Config.tier` from the `.dev` suffix) so the two stacks never collide: signaling 41888/41988, offer 41890/41990, ATC sidecar 7682/7782 (stable/dev). Each is still env-overridable. The client does not hardcode the host's signaling port; the host advertises its bound port in the pairing offer (`PairingPayload.signalingPort`) and the client dials the advertised value.
- **`host-run` is Release** (the primary daily-driver launch, `-configuration Release`); **`host-run-dev` is its Debug (`-Onone`) twin** for fast, breakpoint-friendly iteration. Both, plus `check`, take a `variant` arg (`stable` default | `dev`) — an INDEPENDENT axis from Debug/Release, selecting the `.dev` bundle — e.g. `just host-run-dev dev` (Debug + dev bundle), `just check dev`. The dev variant overrides `PRODUCT_BUNDLE_IDENTIFIER` and `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev` inline (no separate target/scheme). The dev bundle id is env-overridable via `AGENTDESK_HOST_DEV_BUNDLE_ID`.
- The kill-before-relaunch step matches the variant's derived-data path, not a bare `pkill -f AgentDeskHost` (which would kill both hosts). Relaunching one variant never kills the other.
- `fresh-install-dev` / `fresh-diagnostic-run-dev` drive `host-run-dev dev` (Debug), so a `-dev` run is a fully separate stack (dev host + dev client on the dev ports), leaving the stable host running.
- Landing cost, once, when this first ships to an existing install: the stable host's Application Support directory moved from `AgentDesk` to the bundle id, so it re-creates its paired-devices store and regenerates its TLS cert on first launch; **re-pair the daily driver once**. The signing key survives (it is in the keychain, whose service string is unchanged for the stable bundle id). The dev host is a new bundle id, so it needs its **own** one-time Screen Recording and Accessibility approval in System Settings (TCC is keyed per bundle id).

## Agent-run device sessions

- **Stop and wait for an explicit go-ahead before any device install, launch, rebuild, or reinstall.** Recipes that put a build on a device or relaunch the host or client (`host-run`, `host-run-dev`, `iphone-console-run`, the `fresh-install` / `fresh-release-diagnostic-run` family and their `-dev` twins, `client-install`, `client-reinstall`, `pair-iphone`, etc.) are a checkpoint: the agent builds, runs `just check`, prepares the run, states the exact command, and then STOPS and waits for the user to say a phrase like "run it". The agent runs the command itself, but only after that go-ahead. Plain building (`xcodebuild`/`just check`) needs no checkpoint; installing, launching, relaunching, or reinstalling the host or client does. This protects the daily-driver device and keeps the human in control of what lands on hardware.

- When an agent launches the physical iPhone for exploratory media, transport, scroll, decode, or gesture feel work, use a console launch by default: `just iphone-console-run` (client leg only, host already up), or `just fresh-release-diagnostic-run` for a full Release host rebuild + clean reinstall + attached console. For a bounded capture that returns to your prompt, use `just motion-verify` (it records to durable /tmp files for a fixed window, then tears the stream down).
- `just fresh-install` and `just pair-iphone` are the non-console launches; do not use them for exploratory feel runs unless the user explicitly asks for a plain, non-attached launch.
- The attached console path is load-bearing because it writes iPhone-side owned-media diagnostics to `/tmp/agentdesk-client-console.log`, including packet repair, stale skips, decoder recovery, render gaps, and frame age.
- For physical-device media regressions, preserve host logs and attached client logs in the same run. Host-only logs are not enough to judge motion behavior.
- When collecting host unified logs from an agent shell, invoke `/usr/bin/log` explicitly. Do not run bare `log`, because zsh can resolve that as the shell builtin and fail with `too many arguments`.
- Verify the running build is current before trusting any physical-device run, same rule and same `AgentDeskGitSHA` mechanism as under "Simulator automation": `pair-iphone` (like `pair-sim`) re-pairs and relaunches the already-installed client and does not pick up code changes, so judging a feel run after a relaunch can be judging a stale binary. Confirm the host popover and the client both show the current `git rev-parse --short HEAD` before reading results; if a needed surface cannot show its sha, add the readout first.

## Simulator automation (Maestro)

- An end-to-end simulator path validates the owned-media graphics pipeline without a physical phone: bring up the Mac host, install and pair the iPhone simulator client, then drive it with Maestro. Recipes split along two axes, **install-vs-launch** and **blocking-vs-non-blocking**:
  - **Full bring-up (build + install host AND client, then pair):** `just sim-fresh-install` (consoled, blocks; tees client traces to `/tmp/agentdesk-sim-console.log`). For the agent feed specifically use `just agent-feed-sim` (consoled, blocks) or `just agent-feed-sim-pair` (non-blocking, for Maestro driving); these run the Debug stack (host-run-dev), where `sim-fresh-install` runs Release (host-run); both bundle the real sidecar + webviews now, since host-run / host-run-dev build them.
  - **Relaunch only (NO build, NO install):** `just pair-sim` re-pairs and `simctl launch`es whatever client binary is already installed. It does not pick up code changes. The non-blocking leaf sequence to test a code change is `host-run-dev` + `client-sim-reinstall` + `pair-sim` (Debug fast path; use `host-run` + `client-sim-reinstall-release` for Release), then `just ui-flow <flow>`.
  - Then `just ui-flow <flow>` runs a Maestro YAML from `client/maestro/`; screenshots land in `client/maestro/screenshots/`. A non-blocking paired launch plus a flow that does not `launchApp` lets you screenshot and drive gestures while the app stays paired.
- **Verify the running build before driving a flow or trusting a screenshot.** A Maestro drive, a screenshot, or a felt-quality read is only meaningful against the latest code, and the install-vs-launch trap is real: an agent that edits code and then runs `pair-sim` (or a bare relaunch) silently exercises the STALE installed binary and draws wrong conclusions. Before driving, confirm BOTH the host and the client are running the current code: check the in-app build sha (`AgentDeskGitSHA`, shown in the host popover footer and the client unpaired screen) against `git rev-parse --short HEAD`. If a surface you need to trust cannot show its build sha (e.g. the connected client, where the unpaired screen is gone), first add a build-sha readout to that surface, then rebuild+reinstall, then drive. When the running build is not verifiable, treat the run as inconclusive: make the code output its build, check, and only then run the flow. When in doubt, prefer a full bring-up (`sim-fresh-install` / `agent-feed-sim[-pair]`, physical: `fresh-install` / `fresh-release-diagnostic-run`) over a relaunch.
- `client/maestro/scroll-strip-test.yaml` positively exercises the copyRect scroll path. It moves the Mac cursor over a maximized scrollable window, then drives the client right-edge scroll strip. Two preconditions are load-bearing: the scroll must be client-originated (the host scroll hint is fed only by client input, `scrollActivityHints.record(input)`), and the Mac screen must be otherwise calm so the scrolled window is an isolatable damage band. Scrolling the Mac directly does not trigger copyRect, and a busy multi-region screen collapses to full-frame tiles.
- Reading the host log (subsystem `com.example.agentdesk.AgentDeskHost`, category `owned-media`): `acceptedBy=damage` with `commands=2` and a small payload is a copyRect scroll frame (copyRect plus exposed strip); `acceptedBy=damage-tiles` is a small non-scroll change; `acceptedBy=damage-fullframe-tiles` is a whole-surface resend (multi-MB) and is the bandwidth signal to watch.
- Policy: run the simulator drive and the physical-device run ONLY when the user explicitly asks. Do not fire a manual simulator drive or a physical launch for every small change. Default to `just check` for correctness. Reach for the simulator or physical feel runs only on explicit request, or for a media, scroll, decode, or gesture regression that unit tests cannot judge.

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

- Bundle IDs and signing identity (HITL, lives in S0). The experimental client variant's bundle id (`com.example.agentdesk.AgentDeskClient.dev`) and its own App Store Connect record (a bundle id maps to exactly one record, required for the dev variant's TestFlight track) are HITL provisioning. Direct-install of the dev variant needs only the App ID, which Automatic signing can register under team `TEAMID0000`.
- Apple Developer Program account details (HITL).
- Any ambiguites that are not clear from the user prompt.
- When `request_user_input` returns no answers, the question is still unanswered. Ask it again and
  stop; do not infer a recommended default or continue planning or implementation until the user
  responds.
If you find yourself about to pick/assume on the user's behalf, stop and surface it instead.


# Need to revisit
  - http://localhost needs an ATS exception (NSAllowsLocalNetworking)
  since the app isn't sandbox-exempt for cleartext HTTP.
