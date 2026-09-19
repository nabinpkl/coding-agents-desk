# What this file is for

`AGENTS.md` carries **how to operate inside this repo**: conventions, where things live, how decisions get recorded, how work is broken down. It does **not** carry product intent or implementation shape. Those have their own homes:

- **`PRD.md`** what we are building and why. Source of truth for scope, non-goals, and the v0 acceptance test.
- **`SPEC.md`** how v0 is built. Stack, module boundaries, wire shapes, performance budgets.
- **`AGENTS.md`** (this file) how to work in the repo.
- **`FEATURE-MAP.md`** which parts of the tree are the current path, which are dormant, and which solve one problem two ways. Read it before deciding where a change belongs.

Before doing project work, read `FEATURE-MAP.md` first, then `PRD.md` and `SPEC.md` once. They are short on purpose.

Three things `FEATURE-MAP.md` exists to stop you getting wrong, stated here because they are easy to
infer backwards from the shape of the tree:

- **Swift is not the compile path.** Most files here are Swift and `just check` still compiles a lot
  of them, but the working loop is TypeScript: the Vite-served panel in `packages/AgentPanel/Web/`
  and the supervised sidecar in `agent-feed/sidecar/src/`, with `tools/grid-encoder` as the
  native helper behind them. An edit reaches the running system by a page reload, not a rebuild.
  This repo began as a Swift host plus a Swift iOS client and moved off that path because compiling
  and reinstalling dominated iteration; the Swift that remains is lifecycle, transport, security
  boundaries, and OS capabilities.
- **Several approaches to one problem are checked in at once, and the code does not say which is
  current.** A superseded pipeline still compiles and still passes its tests. Do not extend one
  because you found it first, and do not merge two in your head across a compaction: check the map,
  and check `git log` for the directory you are about to edit.
- **Pi is no longer used as a session provider here** (recorded 2026-09-13, on the owner's word).
  Sessions run in Claude and Codex. The Pi provider is still wired in and still looks current:
  `PiAgentBackend` registers in `agent-feed/sidecar/src/server.ts`, Pi sessions still show in the
  sidebar with a PI badge, and `PRD.md` and `SPEC.md` still describe Pi as the directly controlled
  provider. Do not extend it, and do not treat a gap on a Pi row as a bug to fix -- its tool rows
  carry no summary, for one. The Pi SDK itself is NOT dead: `summary/summaryRuntime.ts` runs the
  turn summarizer on `@earendil-works/pi-coding-agent` (the `summaryModel` in `/api/config`), so
  retiring Pi means removing the provider, not that dependency.

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

That last clause is the one to reread before storing something, and the example that used to sit
here is now the example of the clause being SATISFIED rather than of it biting. What is off the
canvas -- whole Bots, and single sessions -- was deliberately not stored, because a canvas that came
back whole cost one click to arrange again where one that came back missing a Bot hid it from a
reader who had forgotten taking it off. That absence is no longer unseeable: the sidebar roster
lists every Bot and every session either way, dims the ones that are off, and carries the control
that puts them back, so both sets are now remembered (`botCanvasPreferences.ts`,
`loadDetachedBotIds` / `loadDetachedSessionKeys`). **Cheap to redo beats quietly wrong** still
decides it -- what changed is that the panel stopped being quiet, not that the cost changed. The
rule is about whether the reader can SEE what was kept, so re-ask that question of the surface as it
is now rather than inheriting an answer. Store identity, never a record the stream owns:
`selectionStore` keeps three strings and
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

## How long a file gets, and how flat a directory gets

Two caps that pull against each other on purpose, because satisfying one alone produces the other's
failure.

**500 lines per file**, for `.ts` and `.tsx` under `packages/AgentPanel/Web/src` and
`agent-feed/sidecar/src`. A file past that has stopped being one idea, and the reader who needs one
of its ideas pays for all of them. Enforced twice: check 5 in `tools/agent-feed-fitness.sh` answers
"is the tree under the cap", and `tools/git-hooks/pre-commit` (installed by `just
git-hooks-install`) asks at the moment the author still has the concepts in their head, which is
the only moment the split is nearly free. The gate is the authority; if the two ever disagree the
hook is the bug.

**12 source files per directory.** A test rides with its source and is not counted separately:
`foo.ts` and `foo.test.ts` are one thing. Past twelve, the directory has stopped being a place and
clusters into sibling subdirectories.

The second cap exists because the first one produces its violation. Measured 2026-09-09, on the day
both trees were brought under the 500-line cap: `features/desktop-viewer/` held **53** source files
flat with no subdirectory, `sidecar/src/http/` **36**, `features/activity-feed/` **26**, `app/`
**24**. Every file was readable and the directory was not. A flat list of fifty hides exactly what a
two-thousand-line file hid, which is where one thing ends and the next begins.

Three numbers, and none of them is a taste call:

- **Twelve is the ceiling**, because this tree's own distribution has a gap there. Its directories
  sit at 53, 36, 26, 24, 20, 17, 16, 15, 13, 13, 12, 12, and then 10 and below. Twelve is where a
  place stops and a pile starts here.
- **Three is the floor, and it is a rule about SPLITTING rather than a property of every
  directory.** When fan-out sends you looking for clusters, a group of one or two is not one: those
  files stay flat and get named for the fact that they belong together, because a subdirectory
  holding two files is a worse index than no subdirectory. It does NOT say a small directory is
  wrong. `features/screen-viewer/` is one file and `src/types/` is one file, and both are a whole
  thing that happens to be small, not the residue of a bad split. So the ceiling is gateable and
  the floor is not: a check that fails every directory under three would fail five that are correct
  as they are.
- **One clustering level below a feature**, and a second needs its reason written beside it.
  `features/activity-feed/data-source/` is the shape. `features/activity-feed/data-source/transport/http/`
  is the failure this bounds: nesting moves the reader's cost from scanning to navigating, and
  navigating is the worse of the two while you still do not know what you are looking for.

**No relative imports, in either tree.** `@/x` is the project's own src and `@repo/x` is the
repository. Both say where a module lives; `../../..` says how far away the reader happens to be
sitting, and the difference is what a file move costs. A relative import breaks when EITHER end
moves, so clustering one directory rewrites every file inside it and every importer of it, and the
move disappears under path arithmetic. Enforced by check 6 of `tools/agent-feed-fitness.sh` and by
`tools/git-hooks/pre-commit`, sharing one expression.

Two details that are easy to get wrong. In Vite the alias keys carry their trailing slash, because
a bare `@` also matches `@agentdesk/agent-feed-wire` and would swallow the wire contract. In
tsconfig, `paths` resolve against the tsconfig's own directory: TypeScript 7 removed `baseUrl`, and
this repo already wrote them without it. Aliased imports carry no extension. Before this landed the
two trees disagreed and nothing could catch it -- the sidecar wrote `.ts` on 652 of 660 relative
imports, the panel on 0 of 770, and both typecheck either way.

**Only fan-out promotes a cluster.** Do not create a directory because a concept feels like it
deserves one. Create it because the flat list went past twelve and three or more of its files are
about the same thing. Concepts do not earn directories, counts do, and that is what keeps the
layout from tracking whoever last had an opinion about it.

Gated since 2026-09-09, and gated the same way the 500-line cap was: only after the tree already
satisfied it. Nine directories were over the ceiling that morning and the worst held 36; the gate
landed on the commit that brought the last one under, because a gate that fails the day it lands
teaches everyone to route around it. Check 7 of `tools/agent-feed-fitness.sh` is the authority and
`tools/git-hooks/pre-commit` asks the same at commit time.

How both trees got here is in `tasks/archive/`: `2026-09-09-ts-500-line-cap.md` carries the
concepts each split file divides on, and `2026-09-09-directory-twelve-file-ceiling.md` carries
which directory became which. Read them before re-deciding one of those boundaries, not before an
ordinary change.

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
- **`sidecar` (`live` default | `bundled`)** spawns `agent-feed/sidecar/src/supervisor.ts` instead
  of the compiled binary. The supervisor owns the server as a child, watches the tree, PARSES what
  changed, and replaces the child only once every changed file is whole -- so this arm executes the
  working tree without a half-saved file being what runs. It replaced `bun --watch src/server.ts`,
  which re-read on every write: a write is a moment inside an edit, and a reload that threw left the
  process alive with its port free, killing every stream the panel held while nothing noticed for a
  minute. Parsed rather than typechecked, because neither tree typechecks at runtime and a resident
  `tsc --watch` cost 844MB at its peak here (`footprint`, 2026-09-15). The Justfile
  resolves `bun` to an absolute path and passes it with the entry (`AGENTDESK_BUN_PATH`,
  `AGENTDESK_AGENT_FEED_SIDECAR_ENTRY`), because the host's child environment is deliberately
  stripped of the PATH that would find a Homebrew install. Every fallback -- no `bun`, unreadable
  entry, non-executable `bun` -- serves the bundled binary and **logs why**, since silently serving
  the frozen one is indistinguishable from an edit that did nothing.
- **The supervisor replaces ITSELF when its own source moves**, by leaving: the host restarts it on
  termination within about a second, and a peer's watcher checks after every ship. Every other way
  of doing it either abandons the running sidecar or races the parent into two supervisors on one
  port. Which files count as its own are computed from its import graph (`supervisorSources.ts`),
  not listed, because a list goes stale silently and the code most likely to be wrong about whether
  it is current is the code that decides when to restart.
- **A restart can be held back, from the panel's Profile menu.** One switch covers this and the
  panel's own HMR, because "stop changing under me" is one thought; the parse gate is unchanged
  either way. A supervisor has no port, so the command goes `POST /api/supervisor` on the sidecar,
  which leaves it on the same rendezvous board the supervisor publishes its state to
  (`<registry>/<user>.supervisor.request.json`), re-read both on a one-second timer and at the
  moment a change is judged -- the timer alone lost a mode chosen a second before a save. A starting
  supervisor clears that file, so a fresh one is always on auto and the dev server re-sends the
  reader's mode to any machine that disagrees with it.
- `just` arguments are POSITIONAL: `just host-run stable live bundled`, not `sidecar=bundled`, which
  would land in `variant`.
- Two hosts can run concurrently, stable and `.dev`, on tier-derived ports so they never collide:
  sidecar 7682/7782, signaling 41888/41988, offer 41890/41990. Each is env-overridable. Identity is
  the bundle id, not a flag: logs, keychain, launchd registration and Application Support directory
  all derive from it, and the kill-before-relaunch step matches the variant's exact installed
  executable rather than a bare `pkill -f AgentDeskHost`, which would kill both.

### A restart used to hand this Mac back the SHIPPED configuration

Settled 2026-09-10, after an evening spent on an IDE that was not broken.

`live` is a property of how the host was **launched**, not of the tree. The two variables that
choose it (`AGENTDESK_BUN_PATH`, `AGENTDESK_AGENT_FEED_SIDECAR_ENTRY`) reach the host only from the
process that launched it, so a host started any other way runs the frozen binary -- and launchd is
the other way. `LaunchAgentInstaller` registers the app with `RunAtLoad` and no environment, so
every reboot started the bundled sidecar and no dev server at all.

It fails silently by construction. Three of the four paths into the bundled arm log a reason, but
the first one does not, because an absent entry variable is not a fallback, it is the shipping path:

```swift
guard let entry = value("AGENTDESK_AGENT_FEED_SIDECAR_ENTRY") else { return bundled }
```

What that looked like: a sidecar compiled before the workspace routes existed, answering
`404 not found` in `text/plain` to every `/api/workspace/*` call, so the IDE surface rendered
perfectly and reported "the sidecar answered 404 with no JSON". Every probe aimed at the panel found
a healthy layer. The only record anywhere on the machine was one `reloadsOnEdit=false` line.

So **this Mac's login launch belongs to the dev path**, installed once with `just dev-login-install`
and reversed with `just dev-login-uninstall`:

- **`com.example.agentdesk.AgentDeskHost.devlogin`** runs `tools/dev-login.sh` -> `just host-login`, which is
  `host-run`'s launch half with no build in it. A login that compiles is a login that can fail to
  produce a host at all.
- **`com.example.agentdesk.AgentDeskHost.paneldev`** runs the Vite dev server in the foreground, `KeepAlive`.
  It is a separate job rather than a child of the first because **launchd reaps a job's process
  group when the job exits**: measured, `agent-webview-dev-ensure` reported "serving at" from
  inside the login job and the port was empty seconds later. A server that must outlive its starter
  has to BE a job -- which is also how it earns a restart when Vite dies at 3am.
- **`com.example.agentdesk.AgentDeskHost.remotesidecars`** runs `tools/remote-sidecar-login.sh` -> `just
  remote-sidecar-watch-all`, `KeepAlive`, a separate job for the same reason the panel's is. It
  reads the peers from `AGENTDESK_PANEL_REMOTE_SIDECARS` in `.env` -- the same string the panel
  resolves peers from -- and for each one keeps its sidecar RUNNING and its sources CURRENT.
  Neither half is worth anything alone: shipping into a dead sidecar and supervising a two-day-old
  tree are the same failure. This is the remote instance of the frozen-runtime bug above. A peer's
  sidecar runs under the same supervisor the Mac's does, so it picks up its sources seconds after
  they change -- but they only changed when somebody ran `ship`, and nobody did. Measured
  2026-09-13 on the oracle peer: up two days and four hours, newest shipped file two days old,
  answering `/api/config` the whole time. **A peer that answers tells you nothing about which code
  it is answering from**, which is why `remote-sidecar-status` now says so out loud. With no peers
  declared the job says so and idles, so installing it before there is a peer is harmless.
- The app's own agent is booted out and deleted by the install, because two `RunAtLoad` jobs have no
  defined order and the loser is whichever host `open` then merely activates. It stays gone: every
  launch this path makes carries `AGENTDESK_DEV_ITERATION_RUN`, which is the flag
  `applicationDidFinishLaunching` checks before registering it.
- `AGENTDESK_AUTO_APPROVE` is **not** set by the login path, though `host-run` sets it. Nobody is
  watching a launch that happens at login, and a pairing request that approves itself on an
  unattended Mac is a different thing from one approved in front of you.
- `host-login` reclaims the sidecar ports first. A sidecar outlives a host that was killed rather
  than asked to quit, and it keeps the port; the new host's sidecar then cannot bind and the machine
  serves the dead host's. Measured while building this: an orphaned bundled sidecar held 7682 while
  `bun --watch` ran beside it, and `/api/workspace/list` answered 404 with both of them up.

`just host-run` is still the iteration command and still the stop-and-wait checkpoint. The login
path only starts what is already installed, so **an installed app moves forward only when you run
`host-run`**.

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

### A delete names an absolute path, and preferably one this run created

Every `rm -rf`, `rmSync`, `rmdir` and `shutil.rmtree` in this repo takes an ABSOLUTE path, built
from a root the script resolved for itself. This is preventive rather than a scar: nothing here has
destroyed a home directory. It is written down because it is the one class of bug with no undo, a
script only gets one chance at it, and every ingredient is already present -- these tools run from
`just` recipes, from launchd, from a sourced shell function, and over ssh, so four different
processes with four different working directories run the same lines.

- **Absolute, because a relative path is interpreted against whatever the cwd happens to be.** `rm
  -rf build` means one thing in the repo and another in `$HOME`, and the `cd` that was supposed to
  make it safe is exactly the command that can fail. `tools/runtime-paths.mjs` already holds the
  read-side of this rule -- `absoluteEnvironmentPath` throws when an override is not absolute --
  and a delete deserves at least what a write gets.
- **Guard the variable, not just the command.** `rm -rf "$ROOT/$NAME"` with `ROOT` empty deletes
  `/$NAME`, and with both empty deletes `/`. `set -u` does NOT catch this: an unset variable is an
  error, an EMPTY one is not, and a `$(mktemp -d)` that failed assigns exactly that empty string.
  One line covers it, before the path is used or trapped: `: "${ROOT:?}" "${NAME:?}"`. Quote every
  expansion, for the reason the argv-quoting section below gives at length.
- **Delete what you created, by the name you were given.** Keep the value `mktemp -d` or
  `mkdtempSync` returned and remove exactly that. Never a glob, never its parent, never a path
  reassembled from pieces. A `trap` installed before the variable is assigned fires with an empty
  one, so assign first and trap second.
- **Anything else gets a confinement check first.** A path from configuration, from a wire request,
  or from a caller is checked to be under the root you expect before it is removed, the way
  `workspace/workspaceBrowse.ts` and `bots/botDirectory.ts` do for listing and binding. A path that
  fails the check is a bug to report, never a path to delete anyway.

Deleting anything you did NOT create is a destructive act under the universal rules and wants a
human's go-ahead, whatever this section says about how to spell it.

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

- **Verify your own work in Chrome for Testing, not in the owner's Chrome.** Playwright's Chrome
  for Testing is what this repo already drives autonomously (`chrome-test/*.mjs`, `just
  dom-mirror-cdp-verify` and its siblings), and it is the default for every question about a change
  you just made: does the surface render it, does the control do what it says, did the number move.
  It gives an independent CDP session, a throwaway profile, console and network from page load
  rather than from whenever a tool attached, and it can be reloaded and killed freely. The panel
  needs no credential to load -- the tailnet is the auth boundary, `AGENT_FEED_HOST` and WireGuard,
  not a login -- so a fresh profile at the dev origin is the real panel with the real sessions in
  it, not a degraded copy.

  **The owner's Chrome answers one question: what is on the owner's screen right now.** Reach for
  the extension tools (`mcp__claude-in-chrome__*`) when that IS the question -- a surface the owner
  says looks wrong, a stream only their tab is holding -- and not to confirm work you can confirm
  yourself. Never the in-app preview browser, which reproduces neither. Two standing costs make
  this the narrow case rather than the default: a tab the owner is not looking at is throttled and
  lies to you in both directions (the two bullets below), and opening the Desktop surfaces from a
  second client makes the sidecar cycle encoders underneath the owner's own stream. A tab you open
  in their Chrome is yours to close when you are done with it.

- **Several agents share this machine, so a Chrome for Testing profile belongs to the RUN, not to
  the script.** Chrome keeps a `SingletonLock` in its user-data-dir: a second instance pointed at
  the same path either attaches to the first browser or refuses to start, so two agents running one
  verifier at the same time is not a slow test, it is a test that reports on someone else's
  browser. The same is true of anything else a harness pins by name -- a port, a socket, a fixture
  file.

  The shape most of `chrome-test/` already uses is the one to copy: `mkdtempSync(join(tmpdir(),
  '<harness>-'))` for the whole working directory, the profile inside it, `listen(0)` for every
  fixture server so the kernel picks the port, and a `teardown` that closes the context and does
  `rmSync(work, { recursive: true, force: true })`, wired to a watchdog timer so a hung run still
  cleans up before exiting non-zero. `input-verify.mjs`, `scroll-verify.mjs`, `record-verify.mjs`,
  `e2e-chrome.mjs` and `browser-projection-e2e.mjs` all do exactly this.

  **Clean up, and do not leave the mess in the repo.** A profile is tens of megabytes and a killed
  run leaves the whole directory behind, so `/tmp` fills with them silently. Never put one under
  the working tree: `cdp-verify.mjs` pinned `.cdp-verify-profile/` at the repo root until
  2026-09-14, which is why that path is still in `.gitignore` -- one fixed name that both collided
  between two agents and left a profile inside the checkout every time a run was killed.

  One constraint pulls the other way and is easy to trip over while making paths unique: a Unix
  socket path has a hard length limit (`SUN_LEN`, 104 bytes on macOS), and a long unique directory
  under `$TMPDIR` blows through it. The failure is a daemon that dies at startup with an empty log.
  Keep sockets short and rooted at `/tmp` even when the profile lives in a long unique path.

- **When the page stops responding, verify in a DEBUG Chrome, not the owner's.** The extension's
  tools run inside the tab they are inspecting: `javascript_tool` is a CDP `Runtime.evaluate`, so a
  renderer that is frozen, spinning, or backgrounded fails it with a 45s timeout, and
  `read_console_messages` and `read_network_requests` come back empty because their tracking never
  started. All three are then reporting on the probe rather than the page, and reading them harder
  tells you nothing.

  So the answer is the same Chrome for Testing this section opens with, pointed at the panel's dev
  origin the way those harnesses point it at their fixtures. What matters here is the specific
  reason: its console and network start at page load rather than whenever a tool attached, and
  nothing it reports is coming from inside the renderer you are asking about.

  Do NOT reach for `mcp__computer-use__app_screenshot` on the owner's Chrome for this. Browsers are
  granted at computer-use's `read` tier, so it can only show what is already on screen, and it
  raises a permission dialog the owner has to answer -- a prompt for a strictly worse observation
  than the debug browser gives for free. `preview_logs` and the dev server's own log are the other
  outside views; a healthy `/api/config` alongside a frozen tab is what tells you the freeze is the
  page and not the server.

- **A screenshot of a HIDDEN panel tab draws rows on top of each other, and the page is fine.**
  Measured 2026-09-10, after chasing it. A hidden tab gets no rendering updates, so React commits a
  row's taller content while the ResizeObserver notification that moves the rows BELOW it is never
  delivered. `captureScreenshot` forces a frame anyway, and paints the new content at the old
  positions: a streaming transcript comes back with prose written across the tool rows under it,
  several places at once, stable enough across two screenshots to read as a layout bug.

  Two tells, both cheap. `document.hidden` is `true`. And running ANY `javascript_tool` call first
  flushes the pending work, so the very next screenshot is nearly clean -- which also means a probe
  INSIDE that tab can never catch this: `setInterval` is clamped to about once a minute after five
  minutes hidden, and the evaluate that reads the DOM is itself what fixes the state you were
  trying to measure. Both of mine reported zero while the screenshot showed the opposite.

  Settle it in Chrome for Testing, which is visible. Seed `agent-panel.selection` in
  `addInitScript` the way `chrome-test/panel-scroll-memory-verify.mjs` does, then sample each row's
  `translateY` against its `offsetHeight`. Two runs against one live streaming session: 734 samples
  over 110s (588 with live rows on screen) and 401 over 60s (377 with live rows), and not one row
  more than 2px out of place in either.

- **Verifying anything you DRIVE belongs in a debug Chrome you control, not the owner's tab.**
  The bullet above is about a tab that stopped responding; this one bites while the page is
  perfectly healthy. A backgrounded tab takes clicks and never takes typing. Measured 2026-09-11
  on the question mirror: `.click()` on a radio updated React exactly as a person would, and both
  ways of typing into a text field beside it -- the native value setter plus a bubbling `input`
  event, and real keystrokes through `computer`'s `type` -- left the DOM value set and React state
  untouched, or did nothing at all. `document.hidden` was `true` throughout and `document.hasFocus()`
  was `true`, so neither one warns you. The result reads as a broken control, which is what it
  looked like for the twenty minutes spent on it.

  This is the sharpest reason the default runs the other way. **Driving** anything -- typing,
  submitting, anything whose whole point is that an input event arrived -- needs a visible,
  foregrounded browser that nothing is competing for, and that is Chrome for Testing. The owner's
  Chrome cannot be it: the tab you want is behind whatever they are actually reading, and a
  backgrounded tab takes your clicks while silently dropping your typing. Where the owner's tab is
  genuinely the subject -- a stream only it is holding, a state only it is in -- read it there and
  drive the reproduction elsewhere, and do not read a null result from a throttled tab as an answer
  about the page.

  The general rule under it is the absent-result one two sections down, with a twist worth naming:
  here the probe produced an ABSENCE OF EFFECT rather than an absence of data, and an effect that
  did not happen is just as cheap for a broken probe to produce as an empty result is.

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
  - **What produces the wrong guess is ADJACENCY, and it wears more than one costume.** On the
    night of 2026-09-08 three sessions each misattributed the same staged rename within an hour,
    from three different inputs: two from PATH adjacency, because `git status` sorts by path so a
    peer's files and yours interleave by directory and read as one arc, and one from
    CONVERSATIONAL recency, because the peer who last messaged you is the one in front of you. A
    fourth instance in the same hour was about a tmux pane rather than a file -- "that is your
    session's pane", said of a pane that was merely the next card along on a canvas -- which is the
    same substitution of proximity for ownership with no file involved at all. Every one of those
    sessions had this bullet in context. So it is not three mistakes, it is one missing step in
    three places, and the step is cheap: the join below is a grep. Spend it at the moment the
    question comes up, which is while reading `git status` or an incoming message, not afterwards
    when a handoff has already gone to the wrong session.
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

### `log show` answers nothing here, so os_log is a live channel and not a record

Measured 2026-09-09, twice in one evening, and it is the absent-result rule above with a specific
face. **`/usr/bin/log show` returns zero lines for EVERY process in this session** -- not just for
debug levels, not just for one subsystem. `log show --last 1m --style compact` with no predicate at
all returned nothing on a plainly busy machine, while `log stream` on the same shell printed
CoreSpotlight traffic immediately. Treat the whole retrospective tool as unavailable.

What that costs, concretely. The host logs every line of the agent-feed sidecar's stdout and stderr
at `.notice` (`AgentFeedSidecarProcess.consumeOutput`), so a `log show` query for that subsystem
returning zero reads as "the host does not keep the sidecar's output". It does keep it. It cannot
be read back from here, which is a different sentence with a different fix, and an hour was spent
on the wrong one.

- **Test the probe against a case that MUST produce output before believing an absence.** One
  unpredicated `log show --last 1m` settles it in seconds, and it is the cheapest second look in
  this file.
- **`log stream` works, and only forward.** Start it, then make the thing happen. It cannot answer
  a question about a failure that already happened.
- **So anything you may need AFTER the fact needs a file.** The sidecar's output is written to
  `/Users/Shared/agentdesk/logs/<user>-agent-feed-sidecar.log`, beside the WebRTC diagnostics log
  and named per user for the same reason (`runtime-paths.mjs`), bounded at 16MB, with a line at
  every spawn so a reader going backwards knows which run they are in.
  `AGENTDESK_AGENT_FEED_SIDECAR_LOG` overrides the path.

One state that used to need noticing by hand no longer does: a `bun --watch` sidecar that threw
during a reload stayed ALIVE with its port free, so every exit-driven restart path missed it. Two
things closed it. The host probes the port rather than the process and restarts after a minute of
silence; and since 2026-09-15 the live arm is a supervisor rather than `--watch`, which never hands
the server a file that will not parse and starts it again if it dies. If a surface goes blank,
`/api/config` answering is still worth checking, but a sidecar sitting dead for half an hour is no
longer the expected shape of that.

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

### And under Bun, a watch you close poisons the NEXT watch on that path

Settled 2026-09-10, and it is the rule above failing in the one way ordering cannot fix. **Every
second `fs.watch` on a path is inert.** Measured with six open/close cycles on one file: Bun 1.3.13
delivered `3, 0, 3, 0, 3, 0` events, Node 26.7.0 delivered `3, 3, 3, 3, 3, 3` for the same script.
It reproduces on raw `node:fs.watch` with no chokidar in it, so it is not chokidar's, and
chokidar's own `unwatch` then `add` alternates identically -- there is no escape except never to
take the path off.

Waiting for the close to finish does NOT help, which is the trap: the close resolves, the guard
that was supposed to order them is satisfied, and the watch that opens next is still dead. Nor
does a gap; it is parity, not timing, and a two-second wait fails exactly as a zero-second one
does.

What it cost: `agent-feed/sidecar` opened one chokidar per followed transcript and closed it with
the last reader, so every second visit to a thread got a dead watch. A card toggled, a reader
moving between two cards on one session, a Vite reload -- each is a close and an open on one path.
The live mirror kept streaming, so the thread looked alive while the file it previews sat still,
and the durable rows appeared only when an unrelated reader opened the same session and forced a
scan. Measured on one session: 320s, 124s and 33s of silence inside ten minutes while the file grew
throughout. Every probe aimed at it found a healthy layer, including a standalone chokidar watch on
the same path in another process, which fired perfectly -- it was the first watch in ITS process.

The answer was one watcher for the process with paths added once and never removed. Two details
that bit on the way there: `chokidar.watch([])` never reaches `ready`, so a watcher created bare
and filled by `add` hangs rather than watching; and 500 watched paths cost no measurable RSS, so
never closing was not the expensive half of it.

#### And then the per-file watches went minutes late anyway, so the index stopped watching

Settled 2026-09-15, from a report that a message sent to a session sometimes never appeared in the
panel. Measured with a throwaway session and 20 sent messages, watching four things at once: the
file on disk, the sidecar's timeline stream, a standalone Bun watcher on the same file, and two
freshly started sidecars built from the same source.

The transcript is never the late half. A `queue-operation` enqueue and the `user` record for the
same message are 30 to 700ms apart across 14 sampled turns, whether the session was idle or
mid-turn. What was late was delivery: 1s, 6s, 16s, 26s, 31s, 51s, 62s, 71s, 77s, 93s, 103s, 123s,
202s, arriving in bursts.

Four measurements place the fault, and none of them is the filesystem. A standalone Bun process
running the same chokidar 5 and a raw `node:fs.watch` on that same transcript fired within one
second on every write throughout. A freshly started sidecar delivered in 1 to 2 seconds every time,
and so did a fresh one started under `bun --watch`, so `--watch` itself is not it. The decisive one
is inside the one degraded process: at the same instants, its catalog watch -- the single recursive
`fs.watch` on `~/.claude/projects` from `watchTree` -- reported `lastEventAt` for the same session
within 3 seconds each time, to the same millisecond value a fresh sidecar reported, while its own
per-file watch on that transcript was 35s and 71s late for those same two writes.

So one recursive watch per corpus stays healthy in a long-lived process where hundreds of per-file
watches do not, and **the event index no longer watches anything**. The catalog's corpus watches
publish every write through `transcriptWrites.ts`, and `followTranscript` routes it to whoever is
reading that file. What this does NOT cover, and what would need a stat of each followed file on a
timer rather than a second watcher: a corpus watch that dies leaves a followed transcript sitting
still with only a line in the catalog's log to say so.

Two things hid all of this for weeks. The panel backfills a hole once a later row exposes it
(`useTimelineGapFill`), so a row that was 90 seconds late usually arrived alongside the reply and
read as normal. And a sidecar that has just reloaded is prompt, so it worked right after every edit
and rotted from there.

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
  - **Committing the INDEX reopens exactly what the pathspec closed, so verify AFTER, not before.**
    That is the gap in the bullet above: a hand-built entry can only be committed by index, and an
    index commit takes whatever is staged at the instant it runs. Measured 2026-09-14, doing it by
    the book: `git diff --cached --name-only` listed the thirteen files intended, and the commit a
    few seconds later landed seventeen, having swept up four `workspace-ide/history/` renames a peer
    staged in between. Checking harder beforehand does not help -- the window is however long you
    take between the check and the commit, and it cannot be closed from here.
    - So **read `git show --stat --name-only HEAD` before pushing**, every time you commit by
      index. That check is not racy, because the commit already happened, and a commit that is
      still local is free to unwind.
    - The unwind: `git reset --soft HEAD~1`, then `git restore --staged` the paths that were not
      yours (both halves of a rename), then commit again. Their WORKTREE is untouched by any of
      that, which is what makes it safe; what they lose is the staging, and they have to `git add`
      it back. Say so rather than leaving them to find it.
    - Narrow the window while you are at it: build and stage the hand-made entries LAST, with the
      commit as the next command. Everything else can be staged minutes earlier without cost.
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

### A session you spin up to PROBE is a throwaway, and the machinery is checked in

`tools/throwaway-session.sh start|say|pane|stop <name>` is how you get a real Claude session to
verify against. Written 2026-09-14, after three sessions in one evening each hand-rolled the same
thing and each rediscovered the same traps.

    id=$(tools/throwaway-session.sh start probe)     # prints the session uuid
    tools/throwaway-session.sh say probe 'Reply with exactly the word: alder'
    tools/throwaway-session.sh say probe /compact
    tools/throwaway-session.sh pane probe
    tools/throwaway-session.sh stop probe

**Probe on the cheap model.** The default is Haiku at `--effort low`, and the reason is not
frugality for its own sake: a probe session exists to produce transcript records and API flows, and
nothing reads what it says. The run that prompted this script spent Opus on the word "acorn", three
times. Override with `THROWAWAY_MODEL` when the probe is genuinely about a model's behaviour.

Four things the script does that a hand-rolled one keeps not doing:

- **The session id is CHOSEN, with `--session-id`, and printed.** Otherwise you find the transcript
  afterwards by grepping `~/.claude/projects/` for the title you passed, which races every other
  session starting in the same second. Three namespaces name one session and none converts to
  another -- see the trap above -- so being handed the transcript uuid up front is most of the job.
- **No tools, via `--disallowedTools`.** A script cannot answer a permission question: the prompt
  appears in the pane and the probe hangs there until somebody looks. This is not sandboxing, it is
  a session with nothing to ask about. `THROWAWAY_TOOLS` widens it, and then answering the pane is
  yours.
- **`say` chunks the text.** `tmux send-keys -l` drops a long string silently, which is already
  written down two sections up; this is where it is implemented, once.
- **Ready means the transcript file exists, not that the pane drew a prompt.** The prompt character
  appears while plugins are still loading. Measured on this repo: ready in about one second, 59k of
  context from the project's own `CLAUDE.md`, which is also why the default cwd is the repo -- a
  probe about compaction needs a context worth compacting.

It runs as the console user in tmux like everything else here, and it is a probe rather than a
worker: give it no job that matters, and stop it when you are done.

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
- **Auto-commit and push every meaningful change.** A meaningful change is a complete logical unit (one R-task, one sub-task, one ADR, one slice of a refactor) where `just check` is green -- and, when the change reaches native code, `just swift-check` too. `just check` covers the current path (TypeScript panel and sidecar, their build system, the grid-encoder helper) and deliberately does not compile the Mac host, the iOS client, or the Swift packages behind them; green there is not evidence about code it never built. **It runs only the legs your current diff can affect**, announcing which ones it picked: a sidecar-only change runs one leg in seconds rather than six in twenty. A path no leg claims runs everything rather than guessing, and native paths are reported with a pointer to `swift-check` rather than silently skipped. `just check-legs` is the full sweep when you want it regardless of the diff, and `check-all` is built on that rather than on `check`. Because the scope is the diff, run it **before** committing; on a clean tree it falls back to what is committed but unpushed, and failing that says there is nothing to check. **That last case still exits 0**, and it is the one to watch for: run `just check` after your work is committed AND pushed and it prints `check: nothing changed since HEAD or upstream. Nothing to check.` and succeeds, which reads exactly like a gate that passed. Measured 2026-09-08, when a session reported a green gate that had measured nothing and caught it only because two lines of log is a suspiciously short one. The tell is the OUTPUT, not the status: a real run names the legs it picked and prints test counts. Same shape as the exit-code bullet further down -- green about the wrong thing -- except here the scope is empty rather than the status swallowed. When you want an answer about already-pushed work, `just check-legs` is the sweep that ignores the diff. Bundle the doc, code, and test changes for that unit into one commit and push to `origin/<branch>` immediately. The standing authorization is this bullet; do not wait for per-commit permission. WIP states, broken builds, and exploratory half-diffs stay uncommitted. If something is genuinely risky (force-push, history rewrite, destructive operation), still confirm first per universal-AGENTS.md.

# Open questions agents should escalate, not invent

- Any ambiguites that are not clear from the user prompt.
- When `request_user_input` returns no answers, the question is still unanswered. Ask it again and stop; do not infer a recommended default or continue planning or implementation until the user responds.
- If you find yourself about to pick/assume on the user's behalf, stop and surface it instead.


# Need to revisit
  - http://localhost needs an ATS exception (NSAllowsLocalNetworking)
  since the app isn't sandbox-exempt for cleartext HTTP.
