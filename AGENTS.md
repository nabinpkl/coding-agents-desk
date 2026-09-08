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
- `docs/dormant-native.md` operating detail for the arcs that are no longer the path -- the iPhone app, host app build variants, on-device diagnostics, the simulator drives. A record to restore from, not a section to extend.
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

**Not implemented on any live surface today** -- it was the native client's, and the browser panel's
desktop navigation does not commit a direction from a finger yet. Recorded because it is a product
decision rather than an implementation detail, and whoever builds it next should not have to
re-derive it.

Horizontal slides that move between desktops use the **opposite of Mac native** by default: sliding
the finger left-to-right brings the LEFT-neighbour desktop into focus. The Mac-native mapping is the
opt-in toggle. The default is load-bearing for the rest-state metaphor "the strip is a scrollbar of
desktops" -- dragging the strip right pulls the previous desktop into the indicator, the way dragging
a scrollbar right pulls earlier content into view. The test for a code path is: finger left commits
"next" (right-neighbour), finger right commits "previous" (left-neighbour).

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

## Panel state: what is remembered, and where

Three places hold state in the Agent Panel, and picking the wrong one is how a reader ends up with a
panel that remembers its font size and forgets which session it was reading.

- **React state** is the default and needs no justification. Anything that should not survive a
  reload belongs here and nowhere else: dialogs, in-flight errors, hover, drag positions mid-drag.
- **The address bar** carries what a *link* should carry, and only that. Today that is the surface
  (`entry`) and the sidebar view (`view`) -- `?entry=feed&view=canvas`. **Query parameters, never
  path segments**: the panel also ships through a custom scheme whose asset resolver maps a request
  path straight onto a bundled file with no fall back to `index.html`, and the build references its
  assets relatively (`base: "./"`), so `/feed/canvas` 404s there even though the dev server answers
  it. Write it with `replaceState`, not `pushState` -- choosing a view is not a navigation, and
  making Back walk the tabs would take a reader out of the panel to leave it.
- **Storage** remembers everything deeper than a link. The reason it exists at all is that this
  panel is edited while it is being read: a Vite save throws away every piece of React state many
  times an hour, and a phone whose webview was discarded comes back the same way.

**The test for whether something is stored** is not "would it be nice to have back". It is:

> Persist a fact about how **this reader arranged the panel**, which would cost them real work to
> re-establish after a reload. Do not persist anything the sidecar already knows, anything derivable
> from what it sends, or anything whose absence a reader cannot see.

That last clause has a scar behind it, and it is the one to reread before storing something: which
Bots are on the canvas is deliberately NOT stored (`AgentPanelApp.tsx`, `detachedBotIds`), because a
canvas that comes back whole costs one click to arrange again, where one that comes back missing a
Bot hides it from a reader who has forgotten they took it off. **Cheap to redo beats quietly
wrong.** Store identity, never a record the stream owns: `selectionStore` keeps three strings and
re-resolves them against the inventory, because a stored `SessionSummary` would be a second source
of truth that nothing refreshes.

**How to write it, today.** Add a field to the nearest existing preferences module for that feature
(`features/sidebar/sidebarPreferences.ts`, `features/bots/botCanvasPreferences.ts`,
`features/sidebar/selectionStore.ts`) rather than starting a new one. Validate every field on the
way in rather than casting -- a stale or hand-edited shape must fall back to the default, not become
a lookup for something that cannot exist -- and wrap every read and write in `try`/`catch`, because
a private window and a container with storage disabled both throw. Write from ONE place, an effect
on the value, rather than beside each of the calls that change it; that is how one of them ends up
forgotten.

**Where this is going.** There are currently three mechanisms doing this one job -- hand-rolled
`load*`/`store*` pairs, `useSyncExternalStore` singletons, and one `zustand` store -- and none of
them has a version or a migration, so every one silently discards a reader's value when its shape
changes. ADR-0114 records the decision to consolidate onto `zustand`'s `persist` middleware (already
a dependency) with `partialize`, `version` and `migrate`, and carries the migration order. Note what
`persist` does NOT change: it makes writing easy enough that the rule above stops being enforced by
friction, so it has to be enforced here. A store that writes everything it holds resurrects
transient state, and each of those comes back as a bug rather than as a convenience.

## Code

- Divider callbacks expose semantic pane growth, never raw platform coordinates: positive grows the leading sidebar or lower terminal. Keep sign flips inside the divider, out of consumers.
- No hardcoded configs. URLs, credentials, tokens, and `~/`-rooted paths go through a central config module, never inline in random files.
- Standalone `＋ IDE`, `＋ Agents`, and `＋ Terminal` windows are independent UUID-backed instances. Persist each open instance's frame and Desktop assignment, remove only a user-closed instance, preserve all open descriptors during host termination, and restore them without activation or any move-to-active-Space fallback. Exact Space movement, display-local ordinal repair, capture, and verification belong to the shared Desktop window-placement authority (ADR-0092), not per-feature copies.
- `.env` is gitignored by reflex. If you create one, gitignore it before the first commit.
- Iteration over compatibility. Until v0 ships, breaking changes are free. After v0, breaking changes require an ADR.
- `SpacesProvider`'s smoke test runs against the live SkyLight binding and is the canary for private-API surface drift across macOS versions. Run it when a macOS update lands.
- `just pty-handover-cross-version [base-ref]` is the canary for PTY runtime wire drift, and the only handover test that is not talking to itself. Every in-process handover test builds both peers from one tree, so it agrees with itself no matter what the wire does; this one builds the runtime from an older commit and asserts the current binaries can still take its live session over (ADR-0080). **Run it after any change to `terminal/pty-manager/proto/` or the handover code**, passing the commit before the change as the base. It is not in `just check` because it cold-builds an older tree. 
- Treat each new feature/debugging arc as scoped by the user's current words, not by the previous arc's implementation surface. Before editing, make the active surface explicit: is the behavior universal across input paths, or limited to a named surface such as the video tile, the scroll strip, the terminal, or settings? If the user asks for universal behavior, start at the shared model and add narrow hooks only as adapters. A fix that branches under `pointerType === "mouse"` does nothing on the phone; see "Two input paths" above.

## Bringing the current path up

`just host-run` is the whole setup, and it is a **stop-and-wait checkpoint**: prepare it, state it,
then wait for the user to say run it. It builds and launches the Mac host, which is not itself the
loop -- it is what supervises the two pieces that are: the panel's Vite dev server and the
agent-feed sidecar. Both are live by default, so an edit to either reaches every attached surface
with no rebuild, no reinstall, and no re-pair.

- **`panel` (`live` default | `bundled`)** starts the panel's Vite server if it is not up, waits for
  it to answer, and points the launch at it. The launch FAILS if that server cannot come up, because
  the dev origin is not a fallback. Pass `bundled` to judge the panel as it actually ships
  (ADR-0095, ADR-0096).
- **`sidecar` (`live` default | `bundled`)** spawns `bun --watch` over `agent-feed/sidecar/src/server.ts`
  instead of the compiled binary. Measured: an edit was visible through `/api/config` about 4s later
  **with the pid unchanged** -- `--watch` re-reads in process and rebinds the port, so the host's
  supervisor never sees an exit. (`--hot` is deliberately not used: hot replacement would leave the
  catalog, the file watchers and the live observers half-swapped.) The cost is accepted rather than
  hidden: this arm executes the **working tree**, so a half-saved file is what runs. The Justfile
  resolves `bun` to an absolute path and passes it with the entry (`AGENTDESK_BUN_PATH`,
  `AGENTDESK_AGENT_FEED_SIDECAR_ENTRY`), because the host's child environment is deliberately
  stripped of the PATH that would find a Homebrew install. Every fallback -- no `bun`, unreadable
  entry, non-executable `bun` -- serves the bundled binary and **logs why**, since silently serving
  the frozen one is indistinguishable from an edit that did nothing.
- `just` arguments are POSITIONAL: `just host-run stable live bundled`, not `sidecar=bundled`, which
  would land in `variant`.
- Two hosts can run concurrently, stable and `.dev`, on tier-derived ports so they never collide:
  sidecar 7682/7782, signaling 41888/41988, offer 41890/41990. Each is env-overridable. Identity is
  the bundle id, not a flag: logs, keychain, launchd registration and Application Support directory
  all derive from it, and the kill-before-relaunch step matches the variant's exact installed
  executable rather than a bare `pkill -f AgentDeskHost`, which would kill both.

### The dev origin is HTTPS over the tailnet, and that is load-bearing

The origin is `https://<this-mac>.<tailnet>.ts.net:5173`, derived per machine by
`tools/tailnet-dns-name.sh` and never written down. One origin serves every surface because TLS is a
property of the port. `just agent-webview-dev` is the same server in the foreground for watching its
log; `agent-webview-dev-cert` issues or renews the certificate; `agent-webview-dev-stop` frees the
port; `agent-webview-dev-status` is the only check that exercises the browser leg, and it checks the
**protocol**, not just the status code.

**A plain browser tab at that origin needs no credential, and that is deliberate.** The sidecar API
has no authentication of any kind: it reads no `Authorization` header and has no 401 path, so a
request with no header and one with a bogus bearer both answer 200. What stands in for auth is the
bind address -- `AGENT_FEED_HOST` defaults to `127.0.0.1`, and a sidecar reached over the tailnet is
authenticated and encrypted at the device level by WireGuard, which is the guarantee loopback was a
proxy for. **Do not reintroduce a token without also making the sidecar check one.** The previous
scheme minted one per dev-server start, wrote it 0600 under the runtime root, had the host send it
as a bearer on every request, and was validated by nobody, so it was removed rather than left
looking like protection.

During an approved host launch, `agent-webview-dev-ensure` reuses a healthy server with intact TLS
or stops the configured port's listener before recreating it; a failed stop or readiness check
aborts the launch. One server means one `/api` target, so a browser tab follows whichever host tier
started it.

## TypeScript-first glue and logging

- First-party interaction glue, iteration policy, and surface-authored diagnostics live in
  TypeScript and the live sidecar by default. Swift remains the thin platform shell for lifecycle,
  the authenticated relay, security boundaries, and OS capabilities that JavaScript cannot own. The
  target is **zero recompilation, zero reinstall, zero relaunch**.
- Reuse the existing `AgentHttpTransport` telemetry path before adding a native log bridge. The
  desktop viewer posts bounded events to `/api/park/tile/:windowID/webrtc/telemetry`; the sidecar
  validates an explicit phase allowlist and appends them to `/tmp/agentdesk-webrtc-diag.log`. This
  works from an already-running surface and updates live with the working tree.
- A proposed Swift change for glue or diagnostics must name the native capability TypeScript cannot
  provide. If there is none, keep it in TypeScript so verification does not acquire a build
  checkpoint.

## Durable runtime and disposable builds

- `.build` is compilation output, not the home of a deployed host, helper, or live panel
  credentials. `tools/runtime-paths.mjs` resolves the durable root, defaulting to
  `~/Library/Application Support/AgentDeskRuntime` with an absolute `AGENTDESK_RUNTIME_ROOT`
  override. Host apps live at `hosts/<bundle-id>/AgentDeskHost.app`, the standalone capture helper
  at `bin/grid-encoder`, and the panel's TLS files under `agent-panel/`.
- For a helper update use `just grid-encoder-install`. It builds and atomically installs without
  rebuilding, reinstalling, or relaunching either app. **The agent session's helper is not in that
  account's runtime root.** Its sidecar sets `AGENT_FEED_GRID_ENCODER_PATH` to a shared location,
  because `~/Library` is 0700 and the console user cannot otherwise reach it, so update it with
  `just grid-encoder-install /Users/Shared/grid-encoder` and check `ps` for the path the resident
  helper actually runs from before believing an install took. Installing to the account's own root
  instead succeeds, reports a path, and leaves the running helper untouched. That account can run
  the install itself: `tools/install-node.sh` puts a pinned, checksum-verified node in its
  `~/.local`, which is what `install-grid-encoder.sh` needs and what the agent account was missing.
  `sh tools/build-grid-encoder.sh` and `just check` only compile candidates. A missing helper reports
  the install command and has no build-directory fallback.
- Do not run cache deletion while builds or tests are active. Moving the runtime does not authorize
  deleting caches, resetting TCC, replacing credentials for a running server, or relaunching a
  daily-driver app. See ADR-0113 for the deployment boundary.

## The native client, host builds, and the simulator are dormant

The iPhone app, its TestFlight release machinery, the iOS/macOS marketing-version and build-number
rules, the on-device QUIC diagnostics pulls, the Maestro simulator drives, and the Chrome extension's
own versioning all had their operating detail here. **Removed 2026-09-07**: the mobile surface is now
the same browser panel as the desktop one, so none of it is on the path a change travels.

The detail is kept, not dropped: `docs/dormant-native.md` holds those sections verbatim, and
`FEATURE-MAP.md` says which directories the arcs live in. Do not re-derive any of it from the tree
and do not extend that file in passing -- it is a record, not a live section. If one of those arcs
genuinely reopens, move the part you need back into this file in the same commit that reopens it,
and re-measure anything you rely on rather than trusting numbers taken months ago.

What survives from all of it is one rule, because it applies to `host-run` too: **stop and wait for
an explicit go-ahead before any install, update, launch, or rebuild that lands on hardware.** Plain
building (`just check`, `just swift-check`) needs no checkpoint; putting a build somewhere it runs
does.

## Browser testing

- **Test the panel in the owner's real Chrome, never the in-app browser.** Use the Chrome
  extension tools (`mcp__claude-in-chrome__*`); the in-app preview browser does not reproduce what
  the owner sees. The panel is a tailnet HTTPS origin holding a WebRTC session with logged-in
  state, and a second isolated browser both fails to load it the same way and disturbs the
  owner's own stream by making the sidecar cycle encoders underneath it.

- **When the page stops responding, verify in a DEBUG Chrome, not the owner's.** The extension's
  tools run inside the tab they are inspecting: `javascript_tool` is a CDP `Runtime.evaluate`, so a
  renderer that is frozen, spinning, or backgrounded fails it with a 45s timeout, and
  `read_console_messages` and `read_network_requests` come back empty because their tracking never
  started. All three are then reporting on the probe rather than the page, and reading them harder
  tells you nothing.

  The answer is a browser this repo already drives autonomously: Playwright's **Chrome for Testing**,
  as in `chrome-test/*.mjs` (`just dom-mirror-cdp-verify` and its siblings). It gives an independent
  CDP session, a throwaway profile, console and network from page load rather than from whenever a
  tool first attached, and it can be reloaded and killed freely -- none of which is true of the tab
  the owner is looking at. Point it at the panel's dev origin the way those harnesses point it at
  their fixtures.

  Do NOT reach for `mcp__computer-use__app_screenshot` on the owner's Chrome for this. Browsers are
  granted at computer-use's `read` tier, so it can only show what is already on screen, and it
  raises a permission dialog the owner has to answer -- a prompt for a strictly worse observation
  than the debug browser gives for free. `preview_logs` and the dev server's own log are the other
  outside views; a healthy `/api/config` alongside a frozen tab is what tells you the freeze is the
  page and not the server.

## The dev origin serves HTTP/2, and it is load-bearing

Settled 2026-09-06, after an evening spent debugging three features that were not broken.

`server.https` gives the panel's dev origin TLS **and HTTP/2** -- but Vite downgrades it to
TLS-only "if the `server.proxy` option is also configured" (its own server-options doc). Under
HTTP/1.1 a browser allows about **six connections per origin**, and this panel holds an EventSource
for the session catalog, the transcript, background tasks, the summary, usage, bots, the session
board and the terminals. More streams than connections.

The stream that loses is whichever the page asks for last, which is the terminals stream, because
nothing opens it until a terminal does. It then fails in the worst available way: **silently**. No
error, no console line, no frame. The screen replay waits on its `onopen`, so the terminal paints
nothing and its footer says `Opening terminal` -- which is true, and stays true forever. Keystrokes
reach tmux and are echoed the whole time; the echo has nowhere to arrive. It is intermittent,
because which stream loses depends on what the page opened first.

So:

- **`/api` is proxied by the `panelSessions` plugin's middleware, not by `server.proxy`.** Adding a
  `server.proxy` entry silently costs the whole origin its HTTP/2. If you need a new proxied path,
  add it to that middleware.
- **A proxy on an HTTP/2 origin must strip hop-by-hop headers in both directions.** `connection:
  keep-alive` from the sidecar's SSE throws `ERR_HTTP2_INVALID_CONNECTION_HEADERS` on the way out,
  and an HTTP/2 request arrives with its pseudo-headers (`:method`, `:path`, `:scheme`,
  `:authority`) in the same map as the ordinary ones, which Node's HTTP/1.1 client rejects with
  "Header name must be a valid HTTP token". Both were measured the first time this origin
  negotiated h2.
- **`just agent-webview-dev-status` checks the protocol**, not just the status code, and fails
  loudly on a downgrade. Run it before concluding a panel surface is broken.

The general lesson is the one already written under "An absent result is a claim about the probe":
what was absent here was a **connection**, and every probe aimed at the feature found a healthy
layer -- `POST /input` answered 204, the PTY daemon echoed input on a hand-driven socket, tmux held
the bytes. All true, all pointing away from a transport that had never connected. When a surface is
blank rather than wrong, **ask whether its stream ever opened** before reading its code.

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

## Where sessions run, and where they are watched

The work and the wall are separate, and conflating them wastes an evening. Settled 2026-09-06:

- **Work runs as the console user, in tmux.** `tmux new-session -d -s <name> -c <repo> 'claude
  --resume <transcript-uuid> --fork-session -n "<label>"'` forks the calling session's context into
  a new one running as the console user, on that user's repo, with that user's permissions. Remote
  Control needs no enabling: it is on, and the forked session appears in the app's sidebar by itself.
- **The agent session is the viewing wall and runs none of the work.** Its Claude Desktop windows
  hold Remote Control *views* of those sessions. Typing a prompt into one of those windows instead
  starts a session inside the `agent` account, which then fails on its own with `Failed to run Look
  for local project folders`, because that account has no project registered. Measured, not assumed.
- **tmux is the backbone, not the interface.** Reading it is `tmux capture-pane -p -t <session>`.
  Driving it by hand is awkward enough that the desktop view earns its place.

Five traps, each of which cost real time:

- **`tmux send-keys -l` silently drops a long string.** 2600 characters produced an empty composer
  and no error, while a short string on the same channel landed. Chunk at ~300 characters with a
  short sleep between them, then send `Enter` as its own call.
- **Three identifier namespaces name one session and none converts to another.** CCD's
  `local_<uuid>` (what `list_sessions` and the cross-session message tool take), the Claude Code
  transcript uuid (what `--resume` takes, and what the `.jsonl` under `~/.claude/projects/` is named
  for), and the `ListAgents` peer name. One session here was `local_eadabff2…` and `35cf85c7…` at the
  same time. A transcript uuid is never a valid message target.
- **The cross-session message tool cannot reach a tmux CLI session.** It knows only sessions the
  desktop app tracks, and a `claude` started from a shell does not appear in `list_sessions` at all.
  Use tmux for those. `SendMessage` is separately disallowed in some sessions, so `ListAgents` will
  cheerfully list peers that cannot be written to.
- **No message channel can stop a running turn.** Not the cross-session tool, whose own description
  says it is for handing off context rather than orchestrating work, and not `SendMessage`. Escape
  twice in Claude Desktop opens **Rewind**, not a stop. Interrupting is a GUI act, and it is the one
  thing the viewing wall is genuinely required for rather than merely convenient.
- **A session has TWO names.** `-n` sets the **address**: it is written to the session's registry
  file as `name`, and that is what `ListAgents` prints and what `SendMessage` addresses. The
  **title** is a `custom-title` record in the transcript, which is what `/resume` shows, what the
  sidecar reads (`claudeTranscript.ts`, `title = customTitle ?? aiTitle`), and what the Agent Panel
  puts on a session.
- **There are two ways to rename and they do NOT do the same thing.** Measured 2026-09-07 on
  v2.1.263, after this file said the wrong thing about both:
  - **`/rename <title>`, in the session**, changes BOTH. It writes a `custom-title` record AND an
    `agent-name` record, and updates the running process's registry `name` to the new value with
    `nameSource: "user"` -- so the pane header, `/resume`, the panel, and `ListAgents` all move
    together. It takes the title inline on one line. This is the complete rename.
  - **`/resume` -> Ctrl+R, from another session**, changes only the title. Measured: a session
    started `-n "Rename probe A"` and renamed through the picker kept **Rename probe A** in the
    registry, with `formerNames` untouched. The picker will not offer you the session you are
    sitting in, so a session cannot rename itself this way.
  - **Appending a `custom-title` record from outside** also changes only the title. It is the only
    one of the three that works on a session with no running process, and the Agent Panel
    deliberately does NOT use it: a rename that moves the title and leaves the address behind reads
    as having worked while every other agent still finds the old name.
- **A renamed session stays findable by its old name.** `/rename` appends to the registry's
  `formerNames` with an `until` stamp, and `ListAgents` prints it: after renaming a live peer, its
  row read `Composer session [cfd12b] - says it was Windows canvas until 28s ago`. So renaming a
  session other agents are mid-conversation with does not strand them.
- **The panel renames by running `/rename` in the session's pane, and three measurements make that
  work.** A bracketed paste of `/rename <title>` IS dispatched as a command -- Claude reads pastes
  literally enough to skip the menu a typed `/` opens, but still runs the command, so the rename
  reuses the composer's ordinary paste path rather than a second input mechanism. It runs
  immediately even mid-turn and does not interrupt the turn. And it is refused when the composer
  holds anything, because the only way to type a command into a box is to type it where the reader
  was writing.
- **A title rename is live everywhere that reads transcripts.** Measured: append a `custom-title`
  record and the sidecar's session list answers with the new title on the very next read -- no
  restart, no cache, last record wins. So the panel, the Canvas and `/resume` pick it up at once.
  Cross-session messaging does not, because it addresses by the registry `name`, which only
  `/rename` moves.
- **Appending a title to a RUNNING session is safe, and the live process adopts it.** Measured
  2026-09-07 against a throwaway session mid-turn: the append landed as the last line, all 33 lines
  still parsed, and the session finished that turn and the next. The CLI re-emits its own
  `custom-title` record periodically -- so the obvious worry is that it overwrites yours -- and it
  does not: after the rename its next re-emission carried the NEW title, which means it re-reads
  the title from its own transcript rather than holding the `-n` name it started with. The pane's
  header keeps showing the address, because an append does not touch it -- `/rename` is what moves
  that, and it moves the header with it.
- **Finding out WHICH session did something is a join, not a guess.** Grep the transcripts under
  `~/.claude/projects/<slug>/` for a symbol or phrase to get a transcript uuid, then map that uuid to
  a peer through `~/.claude/sessions/<pid>.json`, which carries `sessionId`, `name`, `nameSource`,
  `tmux` and `messagingSocketPath` -- and that socket path is verbatim the `from=` on an incoming
  cross-session message. Attribute by that join and never by who created the file: on 2026-09-07 a
  peer inferred authorship from file ownership, and sent a handoff about work in `BotCanvas.tsx` to
  the session that owned the file rather than the one that had written the change.
- **A fork inherits BOTH names verbatim, and the CLI adds no suffix of its own.** Measured
  2026-09-07: `claude --resume <id> --fork-session` with no `-n` produced a session whose registry
  `name` and transcript `customTitle` were byte-identical to its source's. So the `(fork 3)` that
  three sessions here share is not a counter that failed to increment -- it is a name somebody
  typed once, inherited unchanged by every fork since. There is nothing to double up on, which is
  why the panel passes its own `-n "<title> (fork n)"`.
- **Name forks distinctly, because discovery is by name.** Six live sessions here were all called
  "Windows canvas", which makes the bare name address none of them and forces a `[ref]` on every
  send -- and refs are ephemeral, resolvable only from a listing you just read. `-n` is the whole
  fix and it sets both names at once, so a fork started without one is indistinguishable from its
  parent in `ListAgents` from the moment it exists.
- **`--session-id` is accepted alongside `--fork-session`**, and the fork's transcript lands at
  exactly that uuid (measured 2026-09-07 with a chosen id, confirmed in the registry before the
  first turn and in the file name after it). That is what lets the panel name a fork's pane and its
  transcript the same thing rather than discovering the file afterwards.

## An absent result is a claim about the probe until a second look agrees

When the check you wrote to verify a change comes back **empty** -- no scrollback, no rows, no
events, zero bytes, nothing matching -- corroborate it a different way before touching the feature
code. An absence is the cheapest thing a broken probe can produce, and it is indistinguishable from
a broken feature by looking at it harder.

Measured 2026-09-06, on the terminal tiles. A DOM probe read `.xterm-viewport.scrollHeight` to ask
whether imported scrollback had landed, and reported `scrollHeight === clientHeight` twice, across
a reload. Wrong element: xterm's DOM renderer sizes that viewport from a spacer that does not track
the buffer, and the history had been there the whole time. Acting on the absence produced a feature
change made for the wrong reason and then a diagnostic tangent into whether tmux puts its client on
the alternate screen, complete with a hand-rolled pty probe. A single screenshot settled it, and the
real defect was somewhere else entirely: captured lines carried LF without CR, so the history was
present but rendered as a staircase.

Second looks that cost almost nothing:

- **A screenshot of the real surface.** The one thing that cannot report an absence that is not
  there.
- **The same question one layer down or up** -- the API instead of the DOM, the log instead of the
  API, the process table instead of the log.
- **The input rather than the output**: did the bytes arrive at all? A network panel showing a 200
  with a body means the feature worked and the probe did not.
- **Ask the human what they see.** They are looking at it.

Two failure shapes this prevents, both of which happened in one evening: changing working code
because the measurement was wrong, and spending the next hour explaining a phenomenon that never
occurred. The second is worse, because every step of it is sound reasoning from a false premise.

The corollary for the other direction: a probe that reports **success** deserves the same suspicion
when it is the only thing that agrees with you. See also the exit-code rule under Commits, which is
the same mistake at a different layer.

## A channel that is turned off without being awaited will race its own re-opening

Settled 2026-09-08, on the tmux terminal tiles, and the shape recurs anywhere a resource is
exclusive: ONE pipe per tmux pane, one pty per session, one encoder per display, one listener per
port.

`pipeTmuxPane` returned a `stop` that fired `tmux pipe-pane -t <session>` and returned immediately
-- `void tmux([...])`, not awaited. A viewer leaving and one arriving straight after is not an
exotic case here: it is a card being toggled, a reader moving between two cards on one session, a
Vite reload. Those two issue an off and an on for the same pane with nothing ordering them, and the
off wins about as often as it loses. Measured during a burst of opening and closing: `pane_pipe`
read **0 with three viewers attached**, and **1 with none**.

The failure is silent and looks like something else entirely. A terminal with no pipe still opens,
still imports its scrollback through `capture-pane`, still shows a full screen -- and then never
changes again. Every probe aimed at it finds a healthy layer: the session is alive, the pane has
content, `send-keys` lands, the SSE stream is connected. It reads as a hung agent, not as a lost
pipe. The one-line check that settles it is `tmux display -p -t <session> '#{pane_pipe}'`, and the
rule it stands for is: **when a surface stops updating, ask whether its channel is still open before
reading the code that writes to it.**

So a teardown for an exclusive resource RESOLVES when the far end has been told, and whoever
re-opens waits behind it (`TmuxAttachments.closing`). Releasing is called from a viewer detaching,
which cannot block, so the promise is recorded rather than awaited there; `open` is what waits.

The same debugging pass turned up its mirror image, worth knowing because it is invisible in review:
**an `async` IIFE that finishes without ever awaiting runs its own `finally` BEFORE the assignment
that stores it.** The resize applier cleared its in-flight latch inside itself; an applier whose
every iteration hit the already-there branch completed synchronously, the clear ran first, and the
assignment then latched a settled promise that nothing would ever clear again. Measured on three
live cards: each reached a size, took one report that matched it, and ignored every ask after that,
sitting six or seven columns short of its box for good. Clear a latch from OUTSIDE the promise
(`void applier.finally(...)`), where the callback is guaranteed to run after the assignment -- and
swallow that branch's rejection separately, or a failed call becomes an unhandled rejection as well
as a logged one.

## Several sessions share one branch, so re-read before you trust anything

Work here is not serialised. More than one session can be on `main` in this single worktree at the
same time, committing and pushing independently. That is the point of the wall rather than an
accident, and it means the repository is a shared mutable surface, not a snapshot you were handed.

**The first act of every turn is finding out what moved since you last looked.** Not courtesy, a
correctness step, before planning and before editing:

```
git status --short && git log --oneline -5
```

Then re-read any file you are about to change. Your in-context copy may predate someone else's edit
to it, and the edit will not announce itself.

What this actually breaks, observed rather than imagined:

- **A green gate is not necessarily yours.** `just check` runs against the working tree, so another
  session's in-flight edits are inside your result. On 2026-09-06 `agent-panel-web-check` went red
  on a `KeyboardDeck` test belonging to a different session mid-arc, in the middle of an unrelated
  commit. When a leg fails on files your diff never touched, read `git status` before you debug it:
  identifying whose they are is faster than diagnosing someone else's half-written test.
- **Commit by PATHSPEC, not by index: `git commit -- <paths>`.** Staging by path is necessary and
  not sufficient, because the index is shared too. A commit takes the WHOLE index, so a peer who has
  already staged something -- and `git status` says so, with an `R` or `M` in the FIRST column --
  puts it in your commit no matter how carefully you added only your own files. Measured 2026-09-08:
  a peer's `forkTitle.ts -> sessionTitles.ts` rename sat staged while this session added six
  unrelated files, and `git diff --cached --stat` showed all eight. Naming the paths on `git commit`
  itself commits the working-tree copy of exactly those, leaves every other index entry staged, and
  needs no `git reset` to arrange. Check `git diff --cached --stat` before every commit anyway: it
  is the only view that shows what would actually land.
  - The nuance that comes with it: a pathspec commit takes the WORKING TREE version of those paths,
    ignoring anything you staged for them. If you staged part of a file and then kept editing it,
    the whole current file is what lands.
  - **And a pathspec is not enough when the peer is inside the same FILE.** That is the case that
    produced `9d286227` below: the paths named were this session's own, and one of them was a file
    a peer was mid-edit in, so their three functions came along with it. A pathspec bounds which
    files land, never which HUNKS. So before naming a shared hub -- `AGENTS.md`, `wire/index.ts`,
    a barrel, a route table -- read `git diff -- <that file>` and check every added line is yours.
    Where it is not, build that one index entry by hand rather than reaching for `git add -p`,
    which is blocked here: take `git show HEAD:<path>`, apply only your own change to it, hash it
    with `git hash-object -w --stdin`, point the index at it with
    `git update-index --cacheinfo 100644,<blob>,<path>`, and commit the INDEX (no pathspec, which
    would go back to the working tree and undo the whole exercise). The peer's line stays in the
    worktree for them. Done this way on 2026-09-08 for a `wire/index.ts` holding one line of each.
  - `git add -A` and `git commit -a` remain out of the question for the older reason: they sweep up
    whoever is mid-edit in the worktree as well.
  - This is not hypothetical in either direction. On the same night, commit `9d286227` swept up THIS
    session's uncommitted `tmuxSessions.ts` and landed three unrelated exports under a message about
    composer cursor reading. The code survived; the history is now wrong about who added what and
    why, and that is not fixable on a shared branch without a rewrite nobody should do.
- **Never `git checkout --` a file you did not change.** That is not a revert, it is destroying
  another session's uncommitted work with no undo.
- **A clean tree can go dirty between two of your own commands.** A `git status` read at the start
  of a turn is evidence about that instant and nothing afterwards.
- **`git log` may have moved under you too.** Commits appear on `main` that you did not make, so a
  sha you noted earlier is not still `HEAD`.

The failure mode this prevents is not a merge conflict, which is loud. It is acting confidently on a
stale premise: editing around code that changed, reporting a gate result that measured someone
else's work, or reverting a file that was never yours.

## An argv flattened into a shell string must be quoted per argument

This repo hands commands to shells constantly -- tmux runs its pane command through `/bin/sh -c`,
the PTY manager launches through a login shell, and the helper types lines into a terminal. Every
one of those is the same conversion: a list of arguments becomes ONE string, and the shell then
splits it back into arguments. That split is not the inverse of the join unless each argument was
quoted on the way in.

Measured 2026-09-07, and the failure is worth knowing by shape because it does not look like a
quoting bug. `newSessionArgs` built its script with `command.join(" ")` and quoted only the finished
script. That was correct for as long as every argument was a bare token -- `claude`, `--resume`, a
uuid. The first argument with a space in it was a session title passed to `-n`, and the pane printed
`zsh:1: invalid mode specification` twice and then sat at a shell prompt with no agent running.
Nothing in that message says "quoting": zsh had read the `(fork 1)` in `Session (fork 1)` as a
**glob qualifier**, `f` being the file-mode one, so `ork 1` was an invalid mode. A fork that looked
started and was not.

So:

- **Quote every argument, not the assembled string.** `command.map(shellQuote).join(" ")`. Quoting a
  bare token costs nothing, and is what stops the first non-bare one being a bug.
- **Get the single-quote escape right, and check it in the language you wrote it in.** A
  single-quoted shell string cannot contain a single quote, so each one leaves the quoting, adds an
  escaped quote, and re-enters. Writing that in a JavaScript string needs the backslash escaped;
  it was written with one backslash, which JavaScript reads as three plain single quotes, so the
  helper emitted a string that left the shell inside an unterminated quote. It had never fired
  because nothing user-supplied had gone through it.
- **Test the property, not the spelling.** These strings are read by two shells in turn, so
  asserting how they are quoted asserts nothing about whether the argument arrives. Run the
  hazardous cases through the real shells and check the argv the command receives -- a value with
  parentheses, an apostrophe, a `$`, a backtick, a `;`. That is the test that catches both of the
  above; the exact-string assertion that existed did not, because it was written against the
  arguments that already worked.
- **Prefer not to build a string at all.** Where the interface takes an argv (`Bun.spawn`, the PTY
  manager's `arguments`), pass the argv. The quoting question exists only where something insists
  on one string, which here is tmux and the shells it runs.

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
- **`--codec` is required, and both values are Annex-B.** It used to default to `hevc-fmp4`, the
  fragmented-MP4 mode that fed the MSE path, and the stdin loop owning desktop control -- input,
  space navigation, keyframe and bitrate commands -- ran only on the annexb path. So a probe that
  forgot the flag captured and emitted cursor frames exactly as usual while answering nothing at
  all on stdin, which reads as a broken build rather than a wrong invocation (measured 2026-09-05).
  The MSE path was removed on 2026-09-06 and the flag made mandatory, so that trap is closed
  rather than documented; the note stays because an older helper still on a machine has it.
- **Stdin EOF ends a capture.** The helper reads it as "the owner is gone" and exits, which is what
  makes a sidecar reload, crash or kill take its encoders with it. A capture started by hand with
  stdin at `/dev/null` therefore exits immediately; keep stdin open, as sending commands requires
  anyway.
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
