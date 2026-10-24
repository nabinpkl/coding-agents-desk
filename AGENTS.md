# What this file is for

`AGENTS.md` carries **how to operate inside this repo**: conventions, where things live, how decisions get recorded, how work is broken down. It does **not** carry product intent or implementation shape. Those have their own homes:

- **`PRD.md`** what we are building and why. Source of truth for scope, non-goals, and the v0 acceptance test.
- **`SPEC.md`** how v0 is built. Stack, module boundaries, wire shapes, performance budgets.
- **`AGENTS.md`** (this file) how to work in the repo.
- **`FEATURE-MAP.md`** which parts of the tree are the current path, which are dormant, and which solve one problem two ways. Read it before deciding where a change belongs.

Before doing project work, read `FEATURE-MAP.md` first, then `PRD.md` and `SPEC.md` once. They are short on purpose.

This file holds only what applies to every change. Everything else is next to the code it governs, or
under `docs/agents/`, and is read when its situation comes up:

| When you are | Read |
| --- | --- |
| changing or verifying the panel (`packages/AgentPanel/Web/`) | `packages/AgentPanel/Web/AGENTS.md` |
| changing the sidecar (`agent-feed/sidecar/`) | `agent-feed/sidecar/AGENTS.md` |
| verifying a panel change in a browser | `docs/agents/browser-testing.md` |
| running `just host-run`, touching the dev server, the supervisor, the login launch or the runtime root, or changing Swift or `terminal/pty-manager/` | `docs/agents/dev-loop.md` |
| splitting a file, or adding one to a directory near twelve files | `docs/agents/file-and-directory-caps.md` |
| committing (always: several sessions share `main`) | `docs/agents/shared-branch.md` |
| starting, renaming, messaging or probing a Claude or opencode session | `docs/agents/sessions-and-tmux.md` |
| touching `deskzoom/`, the grid-encoder, or driving the agent session's desk | `docs/agents/desktop-and-display.md` |
| looking at a probe that came back empty | `docs/agents/debugging.md` |
| building a shell or tmux command string, or writing any delete | `docs/agents/shell-scripts.md` |
| reading Claude Code's own files for a feature | `docs/agents/claude-files.md` |
| running workers mode, once the user has asked for it | `docs/agents/workers-mode.md` |

Seven things `FEATURE-MAP.md` exists to stop you getting wrong, in full under its "Seven things this
map exists to stop you getting wrong":

- **Swift is not the compile path.** The working loop is TypeScript: the Vite-served panel in
  `packages/AgentPanel/Web/` and the supervised sidecar in `agent-feed/sidecar/src/`, with
  `tools/grid-encoder` as the native helper behind them. Swift is lifecycle, transport, security
  boundaries and OS capabilities.
- **Several approaches to one problem are checked in at once**, and the code does not say which is
  current. Check the map and `git log` for the directory before extending one.
- **Pi is no longer a session provider** (2026-09-13), though it is still wired in. Do not extend
  it or fix its gaps. The Pi SDK still runs the turn summarizer, so that dependency stays.
- **Codex is dormant as a session provider** (2026-10-11), though it is still wired in. Do not
  extend it, suggest extending it, or fix its gaps. Sessions run in Claude and opencode.
- **A Claude session runs in its terminal UI, in a tmux pane, by default; the Agent SDK runner is
  the other mode, picked at creation** (2026-10-20). Remote control reaches only the terminal mode,
  and it is how a session is still reached while the sidecar is down. Both modes are current.
- **The sidebar's Bots tab is dormant in favour of Canvas** (2026-09-15). `BotSidebarPanel` is not:
  it is the Canvas roster too.
- **Canvas session cards are the current iteration; the Sessions tab and its full-width thread
  view are dormant** (2026-09-15). Do not verify a panel change in that view; verify it on a card at
  `?entry=feed&view=canvas`. `SessionView` itself is not dormant: the card renders it.

# Repository layout

- `AGENTS.md` this file. Operating rules that apply to every change, and the index above.
- `packages/AgentPanel/Web/AGENTS.md`, `agent-feed/sidecar/AGENTS.md` the rules for working in those
  two trees. Each has a `CLAUDE.md` beside it that imports it.
- `docs/agents/` operating detail by situation, indexed above.
- `PRD.md` product intent.
- `SPEC.md` technical shape for v0.
- `FEATURE-MAP.md` what is live, dormant, or superseded, and the parallel approaches that must not be conflated. Dated; re-derive it rather than trusting an old date (it carries the commands).
- `docs/dormant-native.md` operating detail for the arcs that are no longer the path -- the iPhone app, host app build variants, on-device diagnostics, the simulator drives. A record to restore from, not a section to extend.
- `README.md` external-facing one-pager. Points at `PRD.md`.
- `architecture-decisions/` one ADR per decision. `TEMPLATE.md` is the starting shape; `README.md` documents the index and lifecycle.
- `mock-design/` Claude Design HTML/CSS/JS handoff bundle. **Reference for visual feel, not a v0 implementation target.** The mocked agent-native UX (per-agent carousel, reasoning ticker) is v1+, not v0.
- `TASKS.md` the iteration ledger (the current one opened 2026-09-10). Retire a ledger to `tasks/archive/` when its arcs are done, before starting new ones, and carry any still-open task's ID forward unchanged.
- `DECISIONS.md` load-bearing choices an agent made that no prompt or ADR dictated, with their evidence.
- `HANDOVER.md` a handover note from 2026-08-25 for the desktop park live tiles; a record, not current instructions.

# How decisions get recorded

- **Product-level scope decisions** edit `PRD.md`. Keep it short. If the change is large enough that it would invalidate published issues, note that in the commit and link the affected issues.
- **Technical decisions that lock something in** write an ADR under `architecture-decisions/`. The first ADR (ADR-0001) records the stack choice in `SPEC.md`. Update `SPEC.md` to reference the ADR by number.
- **Per-iteration plan and progress** go in `TASKS.md`. Do not duplicate ADR or PRD content there.
- **Anything inferable from reading the code** does not need a doc. Skip the ADR.

# Subagents

Subagents and workers mode are opt-in. Do not spawn, start, or delegate to any subagent, worker, reviewer, planner, or parallel agent unless the user explicitly consents for the current task. Consent is task-scoped and does not carry forward. Do not infer consent from task size, complexity, an R-task, or guidance to delegate proactively. Without explicit consent, the active thread plans, implements, reviews, and verifies the work itself.

How workers mode runs once it is asked for: `docs/agents/workers-mode.md`.

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

## Code

- Divider callbacks expose semantic pane growth, never raw platform coordinates: positive grows the leading sidebar or lower terminal. Keep sign flips inside the divider, out of consumers.
- No hardcoded configs. URLs, credentials, tokens, and `~/`-rooted paths go through a central config module, never inline in random files.
- `.env` is gitignored by reflex. If you create one, gitignore it before the first commit.
- Iteration over compatibility. Until v0 ships, breaking changes are free. After v0, breaking changes require an ADR.
- Treat each new feature/debugging arc as scoped by the user's current words, not by the previous arc's implementation surface. Before editing, make the active surface explicit: is the behavior universal across input paths, or limited to a named surface such as the video tile, the scroll strip, the terminal, or settings? If the user asks for universal behavior, start at the shared model and add narrow hooks only as adapters. A fix that branches under `pointerType === "mouse"` does nothing on the phone; see "Two input paths" in `packages/AgentPanel/Web/AGENTS.md`.
- **Lint is part of the gate.** `.oxlintrc.json` lists the rules and the reason for each; check 8 of
  `tools/agent-feed-fitness.sh` runs it over both live trees on every `just check`. Every rule is at
  zero, so a finding is always yours. A new rule lands only with its backlog cleared in the same
  change.
- **So is formatting.** Run `tools/format.sh <your files>` before committing: with no paths it
  rewrites every file in the tree, a peer's half-finished edit included. The pre-commit hook refuses
  a staged file oxfmt would change, and check 9 fails on any such file in the tree (`.oxfmtrc.json`,
  120 columns). It is not run on save, because several sessions edit this tree at once. A reflow
  can push a file past the 500-line cap, and it can move a lint finding off the line its
  `oxlint-disable-next-line` names: split the file, or move the comment onto the line the finding
  is now on.

## Rules that apply everywhere

Each is the short form; the file named holds the full text and the measurements behind it.

- **Name the input path.** Both live surfaces are Chrome at the dev origin: the iPhone sends touch
  and the Mac sends a pointer. The split that matters is `event.pointerType === "mouse"`, not the
  container. A fix under that branch does nothing on the phone, and behaviour meant to be universal
  belongs above it. ("Two input paths", `packages/AgentPanel/Web/AGENTS.md`.)
- **500 lines per file, 12 source files per directory, no relative imports**, in
  `packages/AgentPanel/Web/src` and `agent-feed/sidecar/src` (a test rides with its source; `@/` is
  the project's src, `@repo/` the repository). Fitness checks 5 to 7 and the pre-commit hook enforce
  them. A directory at twelve owes a split of the files already in it: never append a new idea to a
  file named for another, and never give the newcomer a subdirectory of its own.
  (`docs/agents/file-and-directory-caps.md`.)
- **Re-read before you trust anything, and commit by pathspec.** Several sessions commit to `main` in
  this one worktree. Start each turn with `git status --short && git log --oneline -5` and re-read a
  file before changing it. Commit with `git commit -- <paths>`, never `git add -A` or `commit -a`,
  and check `git diff --cached --stat`. A pathspec bounds files, not hunks: when a peer is mid-edit in
  a file you are committing, build that index entry by hand and, after any commit of the index, read
  `git show --stat HEAD` before pushing. Never `git checkout --` a file you did not change. A failing
  leg on files your diff never touched is most likely a peer's. (`docs/agents/shared-branch.md`.)
- **Attach to a DOM node once it is there, not through a ref read once.** Hold the node as state and
  hand the element to the listener or observer, and gate on the element, never on a flag standing in
  for it: a ref still empty when the effect ran is never attached, and nothing says so. Test it with
  the node mounting after the hook. ("Attach to an element when it arrives",
  `packages/AgentPanel/Web/AGENTS.md`.)
- **An empty result is a claim about the probe** until a second look agrees: a screenshot, the layer
  above or below, the input instead of the output, or asking the human. `log show` returns nothing
  in this session; use `log stream` or a log file. (`docs/agents/debugging.md`.)
- **Verify in Chrome for Testing, not in the owner's Chrome**, and on a Canvas session card. A
  backgrounded tab takes clicks and silently drops typing. (`docs/agents/browser-testing.md`.)
- **Reach for an event first, and justify a poll** in a comment beside the timer when nothing can
  tell you. Use the watch shapes that survived here, and never close a watch in the Bun process on
  macOS. ("Reach for an event first", `agent-feed/sidecar/AGENTS.md`.)
- **Never add a `server.proxy` entry to the panel's Vite config.** It silently downgrades the dev
  origin to HTTP/1.1, and the last event stream the panel opens never connects. Proxied paths go in
  the `panelSessions` middleware. (`docs/agents/dev-loop.md`.)
- **Deletes take an absolute path** built from a root the script resolved, guard every variable with
  `: "${VAR:?}"`, and preferably remove exactly what this run created. Deleting anything you did not
  create needs a human's go-ahead. **An argv flattened into a shell string is quoted per argument**,
  and passing the argv is better still. (`docs/agents/shell-scripts.md`.)
- **Probe with a throwaway session** (`tools/throwaway-session.sh`, the cheap model by default), and
  never start a second `opencode serve` on this machine. (`docs/agents/sessions-and-tmux.md`.)
- **Nothing personal goes into the tree.** This repository is being prepared for publishing. Check 10
  of the fitness gate fails on a name, address, account or device id, tailnet name or credential
  shape beyond the baseline recorded when the cleanup began. Take the string out rather than
  recording it. When you remove existing ones, `just public-scan --update-baseline` and commit the
  baseline with the change. (`tools/public-scan/README.md`.)

## Claude's own files are off limits

Never read, copy or use Claude Code's OAuth token or credentials (`~/.claude/.credentials.json`, the
`oauthAccount` block in `~/.claude.json`, and the keychain entries beside them), and never design a
feature that needs them. Write nothing into `~/.claude/` and edit nothing Claude owns, however small.
What a feature knows about a live session comes from the jsonl transcripts under
`~/.claude/projects/` (read-only) or the HTTPS proxy Claude Code supports, and from nothing else. If
a feature seems to need Claude to write something for us, the source is wrong, not the permission.
(`docs/agents/claude-files.md`.)

## Hardware is a checkpoint

The native client, the host builds and the simulator are dormant; their operating detail is in
`docs/dormant-native.md`, a record not to be extended in passing. If one of those arcs reopens,
move the part you need back into an `AGENTS.md` in the commit that reopens it, and re-measure
anything you rely on rather than trusting numbers taken months ago. One rule from them applies to
`host-run` too: **stop and wait for an explicit go-ahead before any install, update, launch, or
rebuild that lands on hardware.** Plain building (`just check`, `just swift-check`) needs no
checkpoint; putting a build somewhere it runs does.

## Commits and PRs

- Small, scoped commits. One slice per PR where possible.
- Commit messages explain the **why**, not the **what** (the diff already shows the what).
- Do not skip hooks (`--no-verify`) or bypass signing unless explicitly asked.
- **Auto-commit and push every meaningful change.** A meaningful change is a complete logical unit (one R-task, one sub-task, one ADR, one slice of a refactor) where `just check` is green -- and, when the change reaches native code, `just swift-check` too. `just check` covers the current path (TypeScript panel and sidecar, their build system, the grid-encoder helper, and the `tools/` shell scripts with their tests) and deliberately does not compile the Mac host, the iOS client, or the Swift packages behind them; green there is not evidence about code it never built. **It runs only the legs your current diff can affect**, announcing which ones it picked: a sidecar-only change runs one leg in seconds rather than seven in twenty. A path no leg claims runs everything rather than guessing, and native paths are reported with a pointer to `swift-check` rather than silently skipped. `just check-legs` is the full sweep when you want it regardless of the diff, and `check-all` is built on that rather than on `check`. Because the scope is the diff, run it **before** committing; on a clean tree it falls back to what is committed but unpushed, and failing that says there is nothing to check. **That last case still exits 0**, and it is the one to watch for: run `just check` after your work is committed AND pushed and it prints `check: nothing changed since HEAD or upstream. Nothing to check.` and succeeds, which reads exactly like a gate that passed. Measured 2026-09-08, when a session reported a green gate that had measured nothing and caught it only because two lines of log is a suspiciously short one. The tell is the OUTPUT, not the status: a real run names the legs it picked and prints test counts. Same shape as the exit-code bullet further down -- green about the wrong thing -- except here the scope is empty rather than the status swallowed. When you want an answer about already-pushed work, `just check-legs` is the sweep that ignores the diff. Bundle the doc, code, and test changes for that unit into one commit and push to `origin/<branch>` immediately. The standing authorization is this bullet; do not wait for per-commit permission. WIP states, broken builds, and exploratory half-diffs stay uncommitted. If something is genuinely risky (force-push, history rewrite, destructive operation), still confirm first per universal-AGENTS.md.

# Open questions agents should escalate, not invent

- Any ambiguites that are not clear from the user prompt.
- When `request_user_input` returns no answers, the question is still unanswered. Ask it again and stop; do not infer a recommended default or continue planning or implementation until the user responds.
- If you find yourself about to pick/assume on the user's behalf, stop and surface it instead.

# Need to revisit
  - http://localhost needs an ATS exception (NSAllowsLocalNetworking)
  since the app isn't sandbox-exempt for cleartext HTTP.

# Where each section of this file went

On 2026-10-17 this file was split, because Codex reads only the first 32 KiB of `AGENTS.md` and it
had grown to 126 KB. Every section kept its heading, and `docs/agents/README.md` lists each one with
the file it is in now, so a reference elsewhere to `AGENTS.md` "<heading>" still resolves.
