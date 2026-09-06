# What this file is for

`AGENTS.md` carries **how to operate inside this repo**: conventions, where things live, how decisions get recorded, how work is broken down. It does **not** carry product intent or implementation shape. Those have their own homes:

- **`PRD.md`** what we are building and why. Source of truth for scope, non-goals, and the v0 acceptance test.
- **`SPEC.md`** how v0 is built. Stack, module boundaries, wire shapes, performance budgets.
- **`AGENTS.md`** (this file) how to work in the repo.
- **`FEATURE-MAP.md`** which parts of the tree are the current path, which are dormant, and which solve one problem two ways. Read it before deciding where a change belongs.

Before doing project work, read `FEATURE-MAP.md` first, then `PRD.md` and `SPEC.md` once. They are short on purpose.

Two things `FEATURE-MAP.md` exists to stop you getting wrong, stated here because they are easy to
infer backwards from the shape of the tree:

- **Swift is not the compile path.** Most files here are Swift and `just check` still compiles a lot
  of them, but the working loop is TypeScript: the Vite-served panel in `packages/AgentPanel/Web/`
  and the `bun --watch` sidecar in `agent-feed/sidecar/src/`, with `tools/grid-encoder` as the
  native helper behind them. An edit reaches the running system by a page reload, not a rebuild.
  This repo began as a Swift host plus a Swift iOS client and moved off that path because compiling
  and reinstalling dominated iteration; the Swift that remains is lifecycle, transport, security
  boundaries, and OS capabilities.
- **Several approaches to one problem are checked in at once, and the code does not say which is
  current.** A superseded pipeline still compiles and still passes its tests. Do not extend one
  because you found it first, and do not merge two in your head across a compaction: check the map,
  and check `git log` for the directory you are about to edit.

# Repository layout

- `AGENTS.md` this file. Operating rules.
- `PRD.md` product intent.
- `SPEC.md` technical shape for v0.
- `FEATURE-MAP.md` what is live, dormant, or superseded, and the parallel approaches that must not be conflated. Dated; re-derive it rather than trusting an old date (it carries the commands).
- `README.md` external-facing one-pager. Points at `PRD.md`.
- `architecture-decisions/` one ADR per decision. `TEMPLATE.md` is the starting shape; `README.md` documents the index and lifecycle.
- `mock-design/` Claude Design HTML/CSS/JS handoff bundle. **Reference for visual feel, not a v0 implementation target.** The mocked agent-native UX (per-agent carousel, reasoning ticker) is v1+, not v0.
- `TASKS.md` (created when the next iteration opens; there is none right now, the last was retired to `tasks/archive/` on 2026-09-05) the iteration ledger, following the guidelines file linked in the load-first section. Retire a ledger to `tasks/archive/` when its arcs are done, before starting new ones, and carry any still-open task's ID forward unchanged.

# How decisions get recorded

- **Product-level scope decisions** edit `PRD.md`. Keep it short. If the change is large enough that it would invalidate published issues, note that in the commit and link the affected issues.
- **Technical decisions that lock something in** write an ADR under `architecture-decisions/`. The first ADR (ADR-0001) records the stack choice in `SPEC.md`. Update `SPEC.md` to reference the ADR by number.
- **Per-iteration plan and progress** go in `TASKS.md`. Do not duplicate ADR or PRD content there.
- **Anything inferable from reading the code** does not need a doc. Skip the ADR.

# Subagents Work Mode(Opt in Otherwise normal chat and implementation as usual)

Subagents and workers mode are opt-in. Do not spawn, start, or delegate to any subagent, worker, reviewer, planner, or parallel agent unless the user explicitly consents for the current task. Consent is task-scoped and does not carry forward. Do not infer consent from task size, complexity, an R-task, or guidance to delegate proactively. Without explicit consent, the active thread plans, implements, reviews, and verifies the work itself.

When workers mode is active, major features run through Codex native threads, not a generic subagent flow. The four standing roles are **Co-ordinator**, **Implementor**, **Reviewer**, and **Small Tasks Doer**.

- **Co-ordinator** is the main control thread and the only integration owner. It owns the live plan, keeps `TASKS.md` current, partitions each coherent phase into ownership lanes, assigns one standing Implementor-Reviewer pair to each lane, coordinates contracts and ordering between lanes, verifies the integrated tree, and decides when a task cluster is ready to commit and push.
- **Implementor** owns one coherent phase or lane for its duration. It takes that lane's R-tasks in sequence, modifies code and tests inside the assigned ownership boundary, self-reviews the complete diff, runs the stated gates after any review corrections, and reports exact files changed, verification results, and remaining risks. It does not promote the ledger, commit, or push.
- **Reviewer** is the standing independent, read-only reviewer for one phase or lane. It retains the lane's context across task reviews and correction rounds, and reviews requirements and complete diffs for correctness, regressions, security, lifecycle cleanup, and missing tests. Findings lead the response, ordered by severity, with file and line references. It does not patch its own findings.
- **Small Tasks Doer** handles narrow, low-risk chores that do not need decomposition: spelling fixes, small doc updates, targeted test additions, mechanical renames, and one-file bug fixes. It does not absorb broad feature work or architecture changes.

## Phase-lane implementor-reviewer loop

When workers mode is active, every R-task that changes behavior uses this loop, but thread ownership persists across the coherent phase or lane. Do not spawn a fresh Implementor or Reviewer for each R-task. The Co-ordinator mediates all handoffs so task scope, review disposition, cross-lane contracts, and repository state have one owner.

1. **Partition.** Before implementation, the Co-ordinator divides the phase only where work has independent ownership boundaries and can progress without concurrent edits to the same files or contracts. It records each lane's ordered R-tasks, dependencies, owned surface, and standing Implementor-Reviewer pair in the live plan. Sequential tasks in the same subsystem stay in one lane so their pair retains context.
2. **Brief.** The Co-ordinator gives the lane's existing Implementor its next R-task or named sub-task with the exact acceptance criteria, allowed surface, relevant paths, required tests, and known unrelated dirty files. The brief names dependencies that must already be green and states that scope
   changes return to the Co-ordinator rather than being assumed.
3. **Implement.** The Implementor reads the current files, writes tests and code, performs the final self-review below, fixes its findings, then runs the task gates against that reviewed diff. It hands back the commit-ready diff without committing, including exact commands and outcomes. A failing or unrun gate is reported plainly.
4. **Review.** The Co-ordinator sends the same task contract and current diff to the lane's standing Reviewer. The Reviewer reads the implementation in repository and accumulated lane context, not only the patch. No findings means it says so explicitly and records residual test gaps; approval is never inferred from silence.
5. **Correct.** The Co-ordinator sends every actionable finding and open question back to the same Implementor. The Implementor either fixes it and reruns affected gates, or returns a concrete technical disagreement with evidence. It does not silently dismiss or defer findings.
6. **Re-review.** The same Reviewer checks the corrections and the complete task diff again. Steps 5-6 repeat until no actionable findings remain. The Co-ordinator resolves disagreements; a disputed correctness, security, data-loss, or lifecycle finding blocks promotion until resolved or escalated to the human.
7. **Integrate the task.** The Co-ordinator checks the actual worktree, performs its own final integration review, fixes any findings, then runs the task-level gates from `TASKS.md` (including `just check`) against that final diff. Only then does it flip the task from R to D. The task code, tests, and ledger transition land in the same commit and are pushed immediately under the repo's commit policy.
8. **Continue or close the lane.** The same pair receives the lane's next R-task without re-onboarding. After its final task, the Reviewer performs one aggregate phase/lane review against the landed tree, and the Co-ordinator runs the phase-level gates and cross-lane integration checks before releasing the pair.

Parallel lanes are created and scheduled only by the Co-ordinator. Contract-producing lanes land before dependent lanes consume them; the Co-ordinator relays contract changes and blocks stale consumers until they refresh. Do not run Implementor and Reviewer edits concurrently on the same lane. Replace a standing thread only when it is unavailable, near its context limit, or demonstrably stale, and give the replacement the full lane contract, landed task history, current diff, review disposition, and next task.

 # Final self-review before handoff

Every agent reviews its own completed diff before handing work back to the human or another Codex thread. This is separate from testing and separate from an external Reviewer pass.

The review exists because edits are temporal: the first file changed was written without seeing the middle and last files that would later land. After the full change exists, re-read the diff as one system and fix incoherencies before reporting completion.

Focused tests may run during implementation for fast feedback. Run the complete required test gates only after this final diff review and after fixing everything it finds. Any full-gate result from before the final review is provisional; if self-review changes the diff, it does not count as final verification.

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

## Two input paths, and they can both be live

Two surfaces drive the same desktop, and either or both may be running at once against one session.
**Both are Chrome**, at the panel's dev origin:

- **Chrome on the iPhone**, sending touch.
- **Chrome on the Mac**, sending a pointer over the rendered page.

The native containers -- the iPhone client app and the host's own webview -- still exist in the code
and still branch, but they are not the current path. `main.tsx` picks its transport from
`window.webkit?.messageHandlers?.agentFeed`, and on both live surfaces that is absent, so both go
through the dev server's `/api` proxy. Treat that native arm the way `FEATURE-MAP.md` says to treat
the rest of the Swift: present, compiling, not where the work is.

So the axis that matters is **not** the container. It is the pointer. A mouse has a position and
real buttons; a touch has neither, and the wire says so
(`agent-feed/wire/desktopControl.ts`): `pointer-warp` carries absolute display coordinates "for a
mouse, which has a position to honour", while touch keeps the relative `pointer-move`;
`mouse-down`/`mouse-up` exist because "a mouse has real buttons to hold; a tap has none, so touch
keeps sending `click`". Touch reaches a drag by synthesising that hold after a long press.

`TileViewport.tsx` branches on `event.pointerType === "mouse"` for absolute warping, button press and
release, and right-click. That branch, not the container, is what splits the two live surfaces.

The practical rule, and the reason this is written down: **when changing input behaviour, name which
path you mean.** A fix that only branches under `pointerType === "mouse"` does nothing on the phone,
and one written against the touch path leaves the Mac's Chrome behaving as it did before. If the
behaviour is meant to be universal it belongs above that branch, in the shared model, with the
branch used only where the two genuinely differ. This is the same trap as the surface-scoping rule
further down: the previous conversation being about one path does not make the next change about it.

## Code

- Cross-platform divider callbacks expose semantic pane growth, never raw platform coordinates: positive grows the leading sidebar or lower terminal. Normalize AppKit's upward-positive and UIKit's downward-positive vertical deltas inside each divider, keep sign flips out of consumers, and test the same physical drag on both platforms.
- No hardcoded configs. URLs, credentials, tokens, and `~/`-rooted paths go through a central config module, never inline in random files.
- Standalone `＋ IDE`, `＋ Agents`, and `＋ Terminal` windows are independent UUID-backed instances. Persist each open instance's frame and Desktop assignment, remove only a user-closed instance, preserve all open descriptors during host termination, and restore them without activation or any move-to-active-Space fallback. Exact Space movement, display-local ordinal repair, capture, and verification belong to the shared Desktop window-placement authority (ADR-0092), not per-feature copies.
- `.env` is gitignored by reflex. If you create one, gitignore it before the first commit.
- Iteration over compatibility. Until v0 ships, breaking changes are free. After v0, breaking changes require an ADR.
- Tests exxists for **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView** .`SpacesProvider`'s smoke test runs against the live SkyLight binding and is the canary for private-API surface drift across macOS versions.
- `just pty-handover-cross-version [base-ref]` is the canary for PTY runtime wire drift, and the only handover test that is not talking to itself. Every in-process handover test builds both peers from one tree, so it agrees with itself no matter what the wire does; this one builds the runtime from an older commit and asserts the current binaries can still take its live session over (ADR-0080). **Run it after any change to `terminal/pty-manager/proto/` or the handover code**, passing the commit before the change as the base. It is not in `just check` because it cold-builds an older tree. 
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
- The leaf client recipes take a `variant` arg (`stable` default | `dev`): `client-install`, `client-reinstall`, `iphone-console-run`, `pair-iphone`, `iphone-log-collect`, `client-archive-release`, `testflight-upload`. `client-install` builds and installs or updates the matching bundle in place, preserving its app container. The historical `client-reinstall` name delegates to that same update-in-place path and never uninstalls. Pass `dev` for the side-by-side AgentDesk Dev build, e.g. `just testflight-upload dev`. The dev bundle id is env-overridable via `AGENTDESK_CLIENT_DEV_BUNDLE_ID`.
- The physical-device feel-run composites are explicit recipes, not arg-driven, because the launch mode matters: `fresh-install` (no console, returns) and `fresh-release-diagnostic-run` (console attached, blocks). `-install` (no console) vs `-run` (attached console) marks the launch mode. Each has a `-dev` suffixed twin (`fresh-install-dev`, `fresh-diagnostic-run-dev`) that drives the Dev build. All rebuild the host and update the client in place without deleting saved app data; the stable pair builds `-configuration Release` (it is the build whose behaviour you are judging), while the `-dev` twins stay Debug for fast, breakpoint-friendly iteration on risky changes. `host-run` / `host-run-dev` now build the REAL bundled artifacts themselves before the host build — the compiled Bun agent sidecar and the Vite agent webview, plus the gesture/voice webview and the voice-server source — so every launch's phone agent surface serves real projects/threads, not a placeholder, and the composites no longer pre-build them. (The sim counterparts `agent-feed-sim[-pair]` are the Debug-stack sim bring-ups; `sim-fresh-install` is the Release one — both bundle real artifacts now and also preserve the simulator app container.) There is deliberately no detached-console composite: a backgrounded console grows the log file unbounded with no teardown. For bounded background capture use `motion-verify` (fixed window, then it tears the stream down).
- **Both surfaces serve the Agent Panel live by default, from one origin, and the HOST decides for both.** `host-run` and `host-run-dev` take `panel` (`live` default | `bundled`); on `live` they start the panel's Vite dev server if it is not already up, wait for it to answer, and point the launch at it, so a TSX edit changes the running Mac host AND every attached phone client with no rebuild, no reinstall, and no re-pair (ADR-0095, ADR-0096). The launch FAILS if that server cannot come up, because the dev origin is not a fallback for the Mac. **The phone legs have no `panel` argument**: the host states its origin over the agent lane on every attach (`agent-panel-origin`), so the phone gets it whether it was launched by `pair-iphone`, from the home screen, or from a TestFlight install, and gets it again after a close and reopen with nothing persisted on the device. A phone attached to a `panel=bundled` host is told exactly that and loads its own bundled build; the client refuses any origin that is not `https`. Pass `panel=bundled` to `host-run` to judge the webview as it actually ships on both surfaces.
- **The dev origin is `https://<this-mac>.<tailnet>.ts.net:5173`, and the https is load-bearing.** iOS refuses cleartext to a tailnet address (`NSAllowsLocalNetworking` does not cover 100.64/10), so the phone leg exists only because `tailscale cert` issues a publicly trusted certificate for the MagicDNS name — **there is no ATS exception in the client and there must never be one**; the stable client is a TestFlight daily driver. The name is derived per machine by `tools/tailnet-dns-name.sh`, never written down. One origin serves both surfaces because TLS is a property of the port: a certificate loaded for the phone ends http on it for the Mac. Where the page's code comes from does not change where its data comes from — the panel picks its transport by whether a native message handler is present, so both surfaces still reach the sidecar through their own host's relay and the control token still never enters the page. The phone's origin arrives over the wire, not from its launch environment: a TestFlight install has no environment, and it is one of the installs that has to work. `just agent-webview-dev` is the same server in the foreground, for watching its log; `just agent-webview-dev-cert` issues or renews the certificate on its own; `just agent-webview-dev-stop` frees the port and the token below.
- **A plain browser tab at the dev origin works too, and the token direction is inverted to make it.** A browser has no relay to attach the sidecar's bearer header, so the dev server's own `/api` proxy attaches it — which needs the server and the sidecar to share one token. The host normally mints one per sidecar spawn and keeps it in memory where nothing can read it, so instead **the dev server mints, into `0600 <runtime-root>/agent-panel/control-token`, and the host adopts it** (`Config.agentFeedSidecarControlTokenOverride`). The server owns the token because it outlives every launch that reuses it. State the cost plainly: while a dev server is up, anything running as this user can read that file and drive the sidecar's control API, which is not true of a host that minted its own. What does *not* change is the relay's guarantee — the token still never enters the page, on any surface. The runtime root is resolved by `tools/runtime-paths.mjs`. During an approved host launch, `agent-webview-dev-ensure` reuses a healthy server with intact TLS/token files or stops the configured port's listener before recreating missing credentials. A failed stop or readiness check aborts launch; never mint a replacement token behind a running server. One server still means one `/api` target, so a browser tab follows whichever host tier started the server. `just agent-webview-dev-status` answers both — it is the only check that exercises the browser leg.
- Both variants register the `agentdesk://` scheme. Dev pairing injects the URL via `devicectl --environment-variables` into a specific bundle id (read in `SceneDelegate`), bypassing system URL routing, so the shared scheme does not affect pairing.

### TypeScript-first WebView glue and logging

- First-party WebView interaction glue, iteration policy, and surface-authored diagnostics live in TypeScript and the live sidecar by default. Swift remains the thin platform shell for lifecycle, authenticated relay, security boundaries, and OS capabilities that JavaScript cannot own. The target for WebView behavior and logging work is **zero app recompilation, zero reinstall, and zero app relaunch**.
- Reuse the existing `AgentHttpTransport` telemetry path before adding a native log bridge. The desktop viewer posts bounded events to `/api/park/tile/:windowID/webrtc/telemetry`; the sidecar validates an explicit phase allowlist and appends them to `/tmp/agentdesk-webrtc-diag.log`. This works from the already-running first-party WebView and updates live with the TypeScript/sidecar working tree.
- A proposed Swift change for WebView glue or diagnostics must name the native capability that TypeScript cannot provide. If there is no such capability, keep the change in TypeScript/sidecar so verification does not acquire a device-build checkpoint.

## Host build variants

The Mac host has the same dev/stable split as the client, and the two hosts run **concurrently** on one Mac (ADR-0037). The stable daily-driver is `com.example.agentdesk.AgentDeskHost`; the experimental host is `com.example.agentdesk.AgentDeskHost.dev` (DEV-badged icon, separate derived-data dir `{{derived_data}}-host-dev`).

- Identity is the bundle id, not a flag. `host/AgentDeskHost/Config.swift` derives `logSubsystem`, `launchAgentLabel`, `dispatchQueuePrefix`, `keychainService`, and the Application Support directory (now `~/Library/Application Support/<bundle-id>/`) from `Bundle.main.bundleIdentifier`. Each variant's logs, keychain, launchd registration, and on-disk state are separate.
- Ports are tier-derived (`Config.tier` from the `.dev` suffix) so the two stacks never collide: signaling 41888/41988, offer 41890/41990, ATC sidecar 7682/7782 (stable/dev). Each is still env-overridable. The client does not hardcode the host's signaling port; the host advertises its bound port in the pairing offer (`PairingPayload.signalingPort`) and the client dials the advertised value.
- **`host-run` is Release** (the primary daily-driver launch, `-configuration Release`); **`host-run-dev` is its Debug (`-Onone`) twin** for fast, breakpoint-friendly iteration. **Release does NOT mean a slow build.** `host-run` sets `SWIFT_COMPILATION_MODE=singlefile`, which keeps `-O` while making the unit of compilation the file rather than the module: measured on one tree with the same one-file edit, the wholemodule default took ~300s and singlefile took 26s (Debug, for reference, 18s). Reach for `host-run-dev` when you want a debugger, not when you want speed — and if you ever need the old behaviour, `AGENTDESK_HOST_SWIFT_COMPILATION_MODE=wholemodule` restores it. The historical reason Release was treated as expensive — a Debug `-Onone` host pegging a core in the crisp tile codec — no longer applies: that path is off by default (`crispTextOverlayEnabled` defaults to false) and `OwnedTileCodec.extractTileWithHash` has a single caller behind that switch. Both, plus `swift-check`, take a `variant` arg (`stable` default | `dev`) — an INDEPENDENT axis from Debug/Release, selecting the `.dev` bundle — e.g. `just host-run-dev dev` (Debug + dev bundle), `just swift-check dev`. `just check` no longer takes one: it stopped building the host when the Swift legs moved to `swift-check`, and a variant with no host build to select would be a lie. The dev variant overrides `PRODUCT_BUNDLE_IDENTIFIER` and `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev` inline (no separate target/scheme). The dev bundle id is env-overridable via `AGENTDESK_HOST_DEV_BUNDLE_ID`.
- **`host-run` and `host-run-dev` also take `sidecar` (`live` default | `bundled`), the agent-feed sidecar's own live-or-frozen axis.** The sidecar ships as a `bun build --compile` standalone binary inside the app, so changing one line of it normally costs a host rebuild, a relaunch, and a re-attach of every surface — the same cost the panel's Vite origin was introduced to remove, for the half of the panel that is not the panel. `sidecar=live` spawns `bun --watch` over `agent-feed/sidecar/src/server.ts` instead. Measured: an edit to a sidecar constant was visible through `/api/config` about 4s later, **with the pid unchanged** — `--watch` re-reads in process and rebinds the port, so the host's supervisor never sees an exit and readiness holds across the reload. (`--hot` is deliberately not used: hot replacement would leave the catalog, the file watchers, and the live observers half-swapped.) It is **`live` by default**, the same as `panel`, so both halves of the panel surface behave alike — an edit anywhere in it is live without a relaunch. The cost is accepted rather than hidden: this arm executes the **working tree**, so a half-saved file is what runs. A run that must judge the artifact as it ships has to ask, and `just` arguments are POSITIONAL — that is `just host-run stable live bundled`, not `sidecar=bundled`, which would land in `variant`. The Justfile resolves `bun` to an absolute path and passes it with the entry (`AGENTDESK_BUN_PATH`, `AGENTDESK_AGENT_FEED_SIDECAR_ENTRY`), because the host's child environment is deliberately stripped of the PATH that would find a Homebrew install. Every fallback — no `bun`, unreadable entry, non-executable `bun` — serves the bundled binary and **logs why**, since silently serving the frozen one is indistinguishable from an edit that did nothing. The `fresh-*` composites do not pass it either, so they inherit `live` too — a feel run judges the working tree unless it is told otherwise.
- The kill-before-relaunch step matches the variant's exact installed executable, not DerivedData or a bare `pkill -f AgentDeskHost` (which would kill both hosts). Relaunching one variant never kills the other.

- `fresh-install-dev` / `fresh-diagnostic-run-dev` drive `host-run-dev dev` (Debug), so a `-dev` run is a fully separate stack (dev host + dev client on the dev ports), leaving the stable host running.
- Landing cost, once, when this first ships to an existing install: the stable host's Application Support directory moved from `AgentDesk` to the bundle id, so it re-creates its paired-devices store and regenerates its TLS cert on first launch; **re-pair the daily driver once**. The signing key survives (it is in the keychain, whose service string is unchanged for the stable bundle id). The dev host is a new bundle id, so it needs its **own** one-time Screen Recording and Accessibility approval in System Settings (TCC is keyed per bundle id).

### Durable runtime and disposable builds

- Plain `just host-run` is the complete stable Release setup: live Agent Panel, live agent-feed sidecar, PTY runtime preparation, standalone desktop-helper installation, voice source/wheelhouse staging, and signed host installation/launch. No separate panel stop/start or helper install is required. Voice starts automatically from its provisioned environment; it is not a watched live-source sidecar. Its models live in installed Application Support assets, not disposable build staging. This command does not install or launch the iPhone app and remains a host-run approval checkpoint.
- `.build` is compilation/test/archive output, not the home of a deployed host, desktop helper, or live panel credentials. `tools/runtime-paths.mjs` resolves the durable root, defaulting to `~/Library/Application Support/AgentDeskRuntime` with an absolute `AGENTDESK_RUNTIME_ROOT` override. Host apps live at `hosts/<bundle-id>/AgentDeskHost.app`, the standalone helper at `bin/grid-encoder`, and the panel's TLS/token files under `agent-panel/`. Pairing state, user data and PTY sockets keep their existing locations.
- `host-run` and `host-run-dev` build a candidate, copy/verify the complete signed app, and launch the installed copy. Keep process discovery on that same exact executable. Never replace a copy with a symlink into build output; never rebuild in place over the live app. Host deployment remains an explicit run checkpoint.
- For a standalone helper update use `just grid-encoder-install`. It builds and atomically installs the helper without rebuilding, reinstalling, or relaunching either app. **The agent session's helper is not in that account's runtime root.** Its sidecar sets `AGENT_FEED_GRID_ENCODER_PATH` to a shared location, because `~/Library` is 0700 and the console user cannot otherwise reach it, so update it with `just grid-encoder-install /Users/Shared/grid-encoder` and check `ps` for the path the resident helper actually runs from before believing an install took. Installing to the account's own root instead succeeds, reports a path, and leaves the running helper untouched. That account can also run the install itself now: `tools/install-node.sh` puts a pinned, checksum-verified node in its `~/.local`, which is what `install-grid-encoder.sh` needs and what the agent account was missing. `sh tools/build-grid-encoder.sh` and `just check` only compile candidates and do not update the installed helper. Only changed installed content advances the helper reuse generation. A missing helper reports the install command and has no build-directory fallback.
- Do not run cache deletion while builds/tests are active. Moving the runtime does not authorize deleting caches, resetting TCC, replacing credentials for a running server, or relaunching either daily-driver app. See ADR-0113 for the deployment boundary.

## Agent-run device sessions

- **Stop and wait for an explicit go-ahead before any device install, update, launch, or rebuild.** Recipes that put a build on a device or relaunch the host or client (`host-run`, `host-run-dev`, `iphone-console-run`, the `fresh-install` / `fresh-release-diagnostic-run` family and their `-dev` twins, `client-install`, `client-reinstall`, `pair-iphone`, etc.) are a checkpoint: the agent builds, runs `just check`, prepares the run, states the exact command, and then STOPS and waits for the user to say a phrase like "run it". The agent runs the command itself, but only after that go-ahead. Plain building (`xcodebuild`/`just check`) needs no checkpoint; installing, updating, launching, or relaunching the host or client does. This protects the daily-driver device and keeps the human in control of what lands on hardware.

- When an agent launches the physical iPhone for exploratory media, transport, scroll, decode, or gesture feel work, use a console launch by default: `just iphone-console-run` (client leg only, host already up), or `just fresh-release-diagnostic-run` for a full Release host rebuild + in-place client update + attached console. For a bounded capture that returns to your prompt, use `just motion-verify` (it records to durable /tmp files for a fixed window, then tears the stream down).
- `just fresh-install` and `just pair-iphone` are the non-console launches; do not use them for exploratory feel runs unless the user explicitly asks for a plain, non-attached launch.
- The attached console path is load-bearing because it writes iPhone-side owned-media diagnostics to `/tmp/agentdesk-client-console.log`, including packet repair, stale skips, decoder recovery, render gaps, and frame age.
- For physical-device media regressions, preserve host logs and attached client logs in the same run. Host-only logs are not enough to judge motion behavior.
- **Client-side evidence comes from the authenticated on-demand QUIC pull, not from the Mac's unified log.** When asked for "the QUIC logs", "the on-demand logs", "the client logs", or client-side evidence of any kind, that is `just client-diagnostics` (append `dev` for the dev stack). The host serves the request over the **active QUIC session input lane**, and falls back to an authenticated frame to the client's tailnet IPv4 on the offer port when the client is paired but not currently connected. Neither path needs USB, `sudo`, `devicectl`, or the phone and the Mac sharing a LAN, so **it works on mobile data** -- which is the point of it existing. It does need the host process running (`just host-run` first), and the fallback needs the client in the **foreground**, because the client stops its offer listener on background.
  - Mechanics, so a failure is diagnosable rather than mysterious: the recipe writes a JSON request file, sends `SIGUSR2` to the host pid, and polls for the host's result file for up to 40s. `host did not write diagnostics result` means the host never answered the signal. A result whose `status` is not `ok` means the host answered but could not reach the client -- check that a session is up, or that the app is foregrounded for the fallback.
  - Output is a private `/tmp/agentdesk-client-diagnostics-<timestamp>/` holding one gzipped NDJSON file per run id plus `summary.json`. `includePreviousRuns` is on, so a run that crashed or was memory-killed is in there too: after a crash, reopen the app and then pull.
  - Siblings on the same authenticated channel: `just client-screenshot` (foreground app screenshot; the iOS "Allow paired Mac screenshots" setting must be on), `just client-debug-bundle` (screenshot plus diagnostics under one request id), and `just voice-phone-logs-pull` (diagnostics plus the voice stage-log summary). `just host-client-telemetry` is host-only and never contacts the phone.
  - `just iphone-log-collect` is a different and heavier thing (device-attached, elevated access) and is **not** the answer to "pull the client logs".
- The host's own unified log is the HOST's view, and the two are not interchangeable. It carries `owned media link telemetry`, whose `client[iface=... radio=... linkQuality=...]` block is the client's self-report relayed over the live session -- second-hand, and it stops the instant the session does. Use it to answer what the host did or what the link looked like while connected; use the on-demand pull to answer what the client did, especially across a disconnect, a background, or a crash.
- When collecting host unified logs from an agent shell, invoke `/usr/bin/log` explicitly. Do not run bare `log`, because zsh can resolve that as the shell builtin and fail with `too many arguments`.
- Verify the running build is current before trusting any physical-device run, same rule and same `AgentDeskGitSHA` mechanism as under "Simulator automation": `pair-iphone` (like `pair-sim`) re-pairs and relaunches the already-installed client and does not pick up code changes, so judging a feel run after a relaunch can be judging a stale binary. Confirm the host popover and the client both show the current `git rev-parse --short HEAD` before reading results; if a needed surface cannot show its sha, add the readout first.

## Simulator automation (Maestro)

- An end-to-end simulator path validates the owned-media graphics pipeline without a physical phone: bring up the Mac host, install and pair the iPhone simulator client, then drive it with Maestro. Recipes split along two axes, **install-vs-launch** and **blocking-vs-non-blocking**:
  - **Full bring-up (build + install host AND client, then pair):** `just sim-fresh-install` (consoled, blocks; tees client traces to `/tmp/agentdesk-sim-console.log`). For the agent feed specifically use `just agent-feed-sim` (consoled, blocks) or `just agent-feed-sim-pair` (non-blocking, for Maestro driving); these run the Debug stack (host-run-dev), where `sim-fresh-install` runs Release (host-run); both bundle the real sidecar + webviews now, since host-run / host-run-dev build them.
  - **Relaunch only (NO build, NO install):** `just pair-sim` re-pairs and `simctl launch`es whatever client binary is already installed. It does not pick up code changes. The non-blocking leaf sequence to test a code change is `host-run-dev` + `client-sim-install` + `pair-sim` (Debug fast path; use `host-run` + `client-sim-install-release` for Release), then `just ui-flow <flow>`.
  - Then `just ui-flow <flow>` runs a Maestro YAML from `client/maestro/`; screenshots land in `client/maestro/screenshots/`. A non-blocking paired launch plus a flow that does not `launchApp` lets you screenshot and drive gestures while the app stays paired.
- **Verify the running build before driving a flow or trusting a screenshot.** A Maestro drive, a screenshot, or a felt-quality read is only meaningful against the latest code, and the install-vs-launch trap is real: an agent that edits code and then runs `pair-sim` (or a bare relaunch) silently exercises the STALE installed binary and draws wrong conclusions. Before driving, confirm BOTH the host and the client are running the current code: check the in-app build sha (`AgentDeskGitSHA`, shown in the host popover footer and the client unpaired screen) against `git rev-parse --short HEAD`. If a surface you need to trust cannot show its build sha (e.g. the connected client, where the unpaired screen is gone), first add a build-sha readout to that surface, then rebuild+install the update, then drive. When the running build is not verifiable, treat the run as inconclusive: make the code output its build, check, and only then run the flow. When in doubt, prefer a full bring-up (`sim-fresh-install` / `agent-feed-sim[-pair]`, physical: `fresh-install` / `fresh-release-diagnostic-run`) over a relaunch.
- `client/maestro/scroll-strip-test.yaml` positively exercises the copyRect scroll path. It moves the Mac cursor over a maximized scrollable window, then drives the client right-edge scroll strip. Two preconditions are load-bearing: the scroll must be client-originated (the host scroll hint is fed only by client input, `scrollActivityHints.record(input)`), and the Mac screen must be otherwise calm so the scrolled window is an isolatable damage band. Scrolling the Mac directly does not trigger copyRect, and a busy multi-region screen collapses to full-frame tiles.
- Reading the host log (subsystem `com.example.agentdesk.AgentDeskHost`, category `owned-media`): `acceptedBy=damage` with `commands=2` and a small payload is a copyRect scroll frame (copyRect plus exposed strip); `acceptedBy=damage-tiles` is a small non-scroll change; `acceptedBy=damage-fullframe-tiles` is a whole-surface resend (multi-MB) and is the bandwidth signal to watch.
- Policy: run the simulator drive and the physical-device run ONLY when the user explicitly asks. Do not fire a manual simulator drive or a physical launch for every small change. Default to `just check` for correctness, plus `just swift-check` when the change is native. Reach for the simulator or physical feel runs only on explicit request, or for a media, scroll, decode, or gesture regression that unit tests cannot judge.

## Browser testing

- **Test the panel in the owner's real Chrome, never the in-app browser.** Use the Chrome
  extension tools (`mcp__claude-in-chrome__*`); the in-app preview browser does not reproduce what
  the owner sees. The panel is a tailnet HTTPS origin holding a WebRTC session with logged-in
  state, and a second isolated browser both fails to load it the same way and disturbs the
  owner's own stream by making the sidecar cycle encoders underneath it.

## The virtual display

- **The 8K desk is a process, and it lives in `deskzoom/`.** `deskzoom/.build/release/DeskZoom
  --display-only` creates one `CGVirtualDisplay` and holds it open; the display exists exactly as
  long as that process does. `~/Library/LaunchAgents/com.example.deskzoom.display.plist` supervises it
  (`Aqua` session type, `KeepAlive`, `RunAtLoad`), installed by `just display-install` from
  `deskzoom/justfile`. Nothing else in this repo creates a display: end that process and every
  desktop stream has nothing left to show.
- **Only the session at the console can create a display, whoever the user is.** One WindowServer
  serves every login session, and displays are a single global arrangement owned by whichever
  session is physically on the Mac. `CGVirtualDisplay` adds to that arrangement and takes no session
  argument; it cannot. Measured 2026-09-05 from both sides: called by `agent` off-console, the
  display landed on the console user's desktop with 29 modes and `agent` never saw it; called by the
  console user it works. Both accounts are admin and in `staff`, so permissions never entered into
  it. Put `agent` on the console and the roles flip exactly. The LaunchAgent therefore belongs to
  whoever holds the console (today `dev`), not to the session that uses the desk.
- **An off-console session gets a frozen copy, taken when the session was created.** Screen Sharing
  hands a non-console session synthesised displays: copies of the console arrangement as it stood at
  session creation, one fixed mode each. Nothing added to the real arrangement later reaches it, and
  the copy is not linked to its original, so it survives the original being destroyed. That is why
  the current route works at all: the 8K was created on the console, recreating the agent session
  snapshotted it, and the copy outlived the console original.
- **Changing the agent session's desk is a sequence, not a setting.** The copy is frozen at one mode,
  so reconfiguring the console 8K does not reach it and DeskZoom's runtime mode ladder is
  unreachable from there. Set the console display to the mode you want, log the agent session out,
  reconnect over Screen Sharing to recreate it, then confirm with `--list-displays` run *inside that
  session*, which is the only way to see what Screen Sharing synthesised: System Settings is a GUI
  and `system_profiler` reports hardware, neither answers for a session.
- **Only one virtual display exists at a time.** `CGVirtualDisplay.apply` returns false for a second
  one whatever its size, measured at both 7680x4320 and 1440x900. Handing the display from one
  holder to another means the old one lets go first, so there is a gap with no desk at all.
- Open, not settled: whether ScreenCaptureKit in an off-console session can capture a synthesised
  display that is not that session's main one. If it cannot, the console's main display has to be
  the 8K at agent-session-creation time.

## Running commands in the agent session

- **Use the helper's `window-input` verb, not VNC typing.** `POST /api/window/input` with a Terminal
  window id and `{"type":"text","text":"...\n"}` runs a command in that session: the helper posts
  the keystrokes in-process, and `text` presses Return on a newline. Measured 2026-09-06 on the same
  command: **0.15s**, against ~12s for a script invoked over VNC and 33s+ for typing the line
  through VNC. Get the window id from `/api/park/state` or `/api/window/audit`.
- **VNC has no command channel and never will.** RFB carries framebuffer updates out and key and
  pointer events in; there is no "run this" message, so a command has to be typed one keysym at a
  time with a hold and a gap. Its own bulk-text message, `ClientCutText`, does not work against
  Apple's screensharingd: measured, the server took it and the clipboard stayed empty. Keep
  `deskzoom/tools/session-client.py` for what it is genuinely good at -- looking at the screen
  (`shot`) and driving pointer gestures -- and reach for `batch` only when the sidecar or its helper
  is not up to answer.
- `ssh` is not an option today: Remote Login is off, though `agent` is already in
  `com.apple.access_ssh`. It would also only cover half the work, because an ssh session has no
  WindowServer connection and so cannot drive Accessibility, raise a window, or post to that desk.

## Display capture

- **Two grid-encoders must never run from one executable path.** replayd, the daemon behind
  ScreenCaptureKit, files every stream client that runs from one path under a single RPClient
  and, when any one of those processes disconnects, stops all of that client's streams ("Stream
  was stopped by the system" / "application connection being interrupted"). Measured 2026-09-05
  with two encoders on one display: SIGTERM to one ended the other within 100 ms; a byte-identical
  copy at another path was untouched. The sidecar therefore spawns each encoder from its own
  numbered copy under the runtime `bin/grid-encoder-slots/` (see
  `agent-feed/sidecar/src/desktop/encoderSlots.ts`). A probe encoder started by hand from the
  installed binary kills the sidecar's live capture the moment it exits; run probes from a copy.
- **Probe the helper with `--codec h265-annexb`, the way the sidecar spawns it.** The stdin loop
  that owns desktop control -- input, space navigation, keyframe and bitrate commands -- runs only
  on the annexb path. Left to the default `hevc-fmp4`, the helper starts, captures, and emits
  cursor frames exactly as usual while answering nothing at all on stdin, which reads like a
  broken command rather than a wrong invocation. Measured 2026-09-05: the same `focus-query` that
  returned silence under the default returned a `text-focus` event immediately with the codec
  passed.
- **See who is streaming before blaming the stream.** `just webrtc-sessions [user]` lists live
  viewers and encoders for that login session's sidecar; `just webrtc-close [user]` ends them
  all, or one with `attempt=` / `pid=`. The diagnostics log for a session is
  `/Users/Shared/agentdesk/logs/<user>-webrtc-diag.log`; encoder lines carry a geometry tag
  (`whole@…` or `x,y,w,h@WxH`) and the slot the encoder ran from.

## Commits and PRs

- Small, scoped commits. One slice per PR where possible.
- Commit messages explain the **why**, not the **what** (the diff already shows the what).
- Do not skip hooks (`--no-verify`) or bypass signing unless explicitly asked.
- **Auto-commit and push every meaningful change.** A meaningful change is a complete logical unit (one R-task, one sub-task, one ADR, one slice of a refactor) where `just check` is green -- and, when the change reaches native code, `just swift-check` too. `just check` covers the current path (TypeScript panel and sidecar, their build system, the grid-encoder helper) and deliberately does not compile the Mac host, the iOS client, or the Swift packages behind them; green there is not evidence about code it never built. **It runs only the legs your current diff can affect**, announcing which ones it picked: a sidecar-only change runs one leg in seconds rather than six in twenty. A path no leg claims runs everything rather than guessing, and native paths are reported with a pointer to `swift-check` rather than silently skipped. `just check-legs` is the full sweep when you want it regardless of the diff, and `check-all` is built on that rather than on `check`. Because the scope is the diff, run it **before** committing; on a clean tree it falls back to what is committed but unpushed, and failing that says there is nothing to check. Bundle the doc, code, and test changes for that unit into one commit and push to `origin/<branch>` immediately. The standing authorization is this bullet; do not wait for per-commit permission. WIP states, broken builds, and exploratory half-diffs stay uncommitted. If something is genuinely risky (force-push, history rewrite, destructive operation), still confirm first per universal-AGENTS.md.

# Open questions agents should escalate, not invent

- Any ambiguites that are not clear from the user prompt.
- When `request_user_input` returns no answers, the question is still unanswered. Ask it again and stop; do not infer a recommended default or continue planning or implementation until the user responds.
- If you find yourself about to pick/assume on the user's behalf, stop and surface it instead.


# Need to revisit
  - http://localhost needs an ATS exception (NSAllowsLocalNetworking)
  since the app isn't sandbox-exempt for cleartext HTTP.
