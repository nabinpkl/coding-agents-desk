# v17 workspace IDE on the live path

Opened 2026-09-10. ADR-0115 is the decision; this is the order it lands in.

The IDE is the last first-party surface on the compile path. It moves to the panel (Vite, live) and
the sidecar (`bun --watch`, live), keeping the `＋ IDE` window as a thin native container.

Gates: `just check` for every task, `just swift-check` additionally for R7-R9.

## Tasks

| ID | State | Task |
|---|---|---|
| R1 | D | ADR-0115 and this ledger. |
| R2 | D | `agent-feed/wire/workspaceIde.ts`: one definition of the IDE contract, exported from the wire index. |
| R3 | D | `sidecar/src/workspace/workspacePaths.ts`: the security core. Component validation and a symlink-refusing walk, tested before anything calls it. |
| R4 | D | `sidecar/src/workspace/workspaceFiles.ts`: list, read, write, atomic rename, sha256 revisions, the 12-case failure taxonomy. |
| R5 | D | `sidecar/src/workspace/workspaceStore.ts` and `workspaceSharedState.ts`: the roster, and the open-tab/expanded-directory state with revisions and operation idempotency. |
| R6 | D | `sidecar/src/workspace/workspaceGit.ts` and `http/workspace-routes/`: git status, the routes, the SSE stream, registration in `server.ts`. |
| R7 | D | `panel/src/features/workspace-ide/`: the surface. Sidebar, editor, tabs, preview, reusing `features/terminal` and `features/activity-feed/markdown`. |
| R8 | D | `?entry=ide`: `panelEntry.ts`, `main.tsx`, `BrowserSurfaces.tsx`. |
| R9 | D | The `＋ IDE` window becomes one `AgentPanelWebViewController` with an entry user script. Dividers, region webviews and the PTY terminal pane go. |
| R10 | D | Delete the IDE's half of `packages/WorkspaceIDE`, its committed resource tree, and the iOS client's `.ide` surface, which the same lane fed. |
| R12 | R | Delete the QUIC workspace lane (`WorkspaceLaneServer`, `WorkspaceLaneSession`) and the host services left with no consumer. |
| R13 | D | Persist the text of a file autosave will not rescue -- conflicted, or last-write-failed -- with the revision it was typed against. |

### What R10 turned out to be

`packages/WorkspaceIDE` was two documents in one dependency tree, not one: the IDE, and the
retained single-file viewer that `WorkspaceShell`'s editor still opens over `app://`. So the
deletion is a bisection rather than a `rm -rf` -- the `ide.html` entry, its sources and its Swift
target go, the viewer and its target stay, and the package keeps its now-oversized name because
renaming the directory would rewrite two Xcode projects' package references for no behaviour.

The iOS client came with it. Its `ControlSurface.ide` rode the QUIC workspace lane ADR-0115
retires, so the surface could not outlive the lane's deletion; that is 3 files, an enum case and
its ~19 call sites, and one case off the `ClientRuntimeSurface` diagnostics enum.

R12 is what is left: the lane itself, plus `WorkspaceFilesResponder`, `WorkspaceFileService`,
`WorkspaceFilePOSIX` and `WorkspaceIDEStateCoordinator`, which the lane was the only consumer of.
It is split out because it is ~1200 lines of host Swift whose unwinding wants a compiler in the
loop, and because the lane compiles harmlessly in the meantime with nothing dialling it.

### Read back against the Swift, 2026-09-10

The port was written from a reading of the Swift, and the Swift was deleted in the same arc, so it
was read back one more time while both still existed. Five behaviours had not survived, all of them
in the same place -- the gap between a keystroke and the bytes reaching disk -- and all five are now
fixed with a test each in `workspaceIdeEditing.test.tsx`: a tab closing inside the autosave delay
took the last keystrokes with it; a conflicted tab closed and discarded the reader's side; `Keep
mine` fetched the new revision and then wrote nothing; a second write could start while one was in
flight and conflict with the reader's own save; and a file another reader closed lost its tab while
this reader still had unsaved text in it. Two more that had survived intact and were suspected
wrongly: the read-only kinds, and the directory collation, which matches `localizedStandardCompare`
name for name on every case tried.

### R13, and where a draft lives

Autosave covers the ordinary case: an edit rests 900ms and is written, and closing a tab waits for
that write rather than racing it. It has exactly two holes, and both are unbounded in time rather
than 900ms wide:

- **A conflicted file never autosaves.** `edit` declines to schedule one, correctly -- the write
  would clobber whoever moved first. So between the conflict appearing and the reader resolving it,
  that text is in React state and nowhere else.
- **A failed write is not retried** until the next keystroke. The Swift did the same, so it is
  faithful rather than a port bug, but it has the same shape.

The Swift's `WorkspaceIDEFileDraftStore` also did something autosave cannot: each draft carried the
revision it was typed against, so reopening compared that to disk and restored the file *already
marked conflicted* if it had moved. Without that, a restart loses not just the text but the fact
that there was a divergence -- the reader is shown the file on disk with no sign their version
existed. `reconcileDraft` is that comparison, and its four answers are the whole lifecycle: none,
identical (stale, dropped), unsaved, conflict.

**`sessionStorage`, not `localStorage`, and not the sidecar.** A half-typed edit is private to the
tab that typed it, so two tabs on one file keep their own rather than overwriting each other
silently, and nothing is shared between the phone and the Mac that the reader did not share. The
sidecar was rejected for the same reason it first looked right: it has no quota, but it would make
drafts shared state, and shared state is the thing a draft is not.

The quota question that sent it there is answered by the choice. Measured 2026-09-10 at the dev
origin in Chrome for Testing: one `localStorage` key holds 4MB and throws `QuotaExceededError` at
5MB, and the text cap is 4MB -- so one draft of a file at the limit would take the whole of it,
while every other thing the panel remembers shares that quota and swallows its own write failures
by house rule. They would not fail loudly; the reader's panel would quietly stop remembering its
arrangement because one large file was open. `sessionStorage` has an **independent** quota: 4MB
stored there with `localStorage` already holding 4MB, and an ordinary preference write still
succeeding alongside both. It also survives a reload, which is the threat, and dies with the tab,
which is the cleanup -- so there is no long tail of stale drafts to evict.

What is left is bounded rather than open: a quota failure evicts the oldest draft and retries, and
if it still cannot keep the text it says so, because that is the one case where a reader is relying
on something that is not there.

Worth knowing while sizing any of this: a 4MB file is not usable in the editor today regardless.
R11 records that `CodeEditor.tsx` is a textarea with no virtualisation, so it lays out every line.

## Open, and blocked on the environment rather than the design

| ID | State | Task |
|---|---|---|
| R11 | R | Swap `features/workspace-ide/editor/CodeEditor.tsx` onto CodeMirror, and restore the Word preview in `FilePreview.tsx`. |

`bun add` cannot reach the npm registry from this machine: every run fails
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` on a different package, including ones it fetched a moment
earlier, while `npm view` against the same registry succeeds. It is bun's bundled CA store against
something intercepting TLS here; `--cafile` with the exported system roots does not fix it.

The two ways past it are both worse than waiting: turning off certificate verification, or adding a
second lockfile, which `ensure-js-dependencies.mjs` refuses on purpose (one lockfile per project,
`--frozen-lockfile`). So the editor ships on the panel's own `shiki` -- a textarea over a
highlighted layer -- and the Word preview says what it needs instead of drawing nothing.

What that costs today, so it is not discovered as a surprise: no bracket matching, no multiple
cursors, no folding, and no virtualisation, so a very large file lays out every line. What it keeps:
highlighting, the browser's own undo and find, and a caret that behaves like every other text field.
Both are one file each when the registry is reachable:

```
bun add @codemirror/state @codemirror/view @codemirror/commands \
        @codemirror/language @codemirror/language-data @codemirror/theme-one-dark docx-preview
```

### Read back a second time, against the SURFACE, 2026-09-10

The first read-back covered the editing path, which is where text gets lost, and was reported as
though it covered the port. It did not. Every deleted web source was compared against what replaced
it: `tree.ts`, `activityBar.ts`, `sourceControl.ts`, `ideModel.ts`, `editor/mount.ts`, `dom.ts`,
`projection.ts`, `mount.ts`, and the generated icon table.

Faithful, checked line by line: the tree's aria labels, the chevron-as-the-directory-mark decision,
the rule that ignored rows are dimmed but never badged, the git tones, the source-control grouping
including the porcelain conflict set and the deliberate double-listing of a path edited in both
index and worktree, the tab strip with drag reorder and its three save marks, the breadcrumb, the
conflict bar, read-only kinds forcing preview, and the empty states.

Two suspicions raised and disproved by reading rather than assuming, both worth recording so they
are not re-raised:

- **`image` and `pdf` file kinds.** The old `projection.ts` declared them and the port has no branch
  for either. But `WorkspaceKit.WorkspaceFileKind` -- the authority the host actually produced from
  -- is exactly `docx | html | markdown | notebook | text`, the same five the wire has now. The old
  TypeScript type was wider than anything that ever reached it.
- **Roster management.** `WorkspaceIDEPlatformCapabilities` carried `removeWorkspace`,
  `reorderWorkspaces`, `assignDesktop` and `autoAssignDesktop`, all granted on the Mac, and the
  window controller handled all four intents. The web `Intent` union declared none of them and
  `mountSidebar` rendered select-plus-add and nothing else. So the IDE never exposed them: the
  plumbing existed for a surface that was never built. Adding them now is new work, not a restore.

What was genuinely a shortcut, and is fixed: **the file icons**. The port mapped ~45 extensions onto
`lucide-react` outlines, which is one grey page repeated down a tree. The generated
material-icon-theme subset was recovered from history as data -- 91 icon families, 667 extensions,
443 filenames -- and is committed as `sidebar/fileIcons.json` rather than a 1200-line `.ts`, because
it is generated output with no logic in it and the 500-line cap governs source. Colour is the point:
it is what makes a language findable before the name is read.

Still open, and recorded rather than fixed: **zoom has no control on a touch surface**. The old
toolbar carried `-` and `+`; zoom now lives at the panel window level (`PanelWindowZoom.swift`,
Command-plus / Command-minus / Command-zero), which is better on the Mac and leaves a phone with
nothing.

### The roster the port left behind, 2026-09-10

Two things the move off the compile path dropped on the floor, found by opening the IDE and seeing
one project in a roster that had fifteen.

**The existing workspaces were never carried across.** The host's registry
(`~/Library/Application Support/<bundle id>/workspaces.json`) still held all fifteen, intact; the
sidecar's roster held whatever had been added since. `tools/import-host-workspaces.mjs` moves them,
idempotent by root, and is a TOOL rather than code in the sidecar on purpose: migration scaffolding
inside the product has to be read and maintained by everyone who follows, for a job that happens
once per machine. The sidecar still decodes only its own shape and has no idea the host's file
exists.

**Adding one was a `window.prompt` for an absolute path.** On a phone that asks a touch keyboard to
type `/Users/...` correctly; on either surface it makes the reader hold the filesystem in their
head. It is a folder picker now, which needs a served listing because nothing in the web platform
hands a page an absolute directory path -- `<input webkitdirectory>` included.

`/api/workspace/browse` is **confined to the home directory, and that is a security boundary rather
than a convenience.** The sidecar has no authentication; what stands in for it is the bind address
plus WireGuard. Registered roots already expose their file contents, but enumeration is different in
kind: unconfined, anyone who could reach the sidecar could walk the whole disk reading directory
names. Symlinks are excluded for a second reason -- `workspaceStore.add` refuses a symlinked root,
so offering one would be offering a choice the next step declines.

## Not in this arc

- **Desktop assignment from the IDE sidebar.** ADR-0115 records why it leaves rather than moves.
- **Renaming `agent-feed/`.** The port that is still open, per `FEATURE-MAP.md`. Untouched here.
- **`WorkspaceFileViewer`.** The standalone `app://` viewer is a separate surface with a live
  consumer (`WorkspaceShell/Editor/FileViewer.swift`); R10 deletes only what the IDE owned.

---

# Terminal canvas (opened 2026-09-19)

Replace the flat tmux wall (`TerminalsSurface`) with a canvas of parent/child terminal
cards: parents are project directories (automatic grouping), children are tmux sessions
(plain attaches). Same canvas UI internals, activity feed swapped for terminals only.
No provider semantics anywhere -- vocabulary is tmux sessions + project directories.
Children exist to run any coding agent (`opencode`, `codex`, …).

Decisions (asked one by one, all answered): automatic grouping by directory; replaces
the wall with a residue parent for ungrouped sessions; kill-session included behind a
confirm; multi-machine mirroring the canvas.

Gates for every task: `bun run test`, `tsc --noEmit`, `just agent-feed-fitness`,
Chrome-for-Testing phone viewport. Commit + push per repo policy.

## Resolved in code before planning (not assumed)

- **Create needs a wire addition.** `identifyTmux` sets `createTmux: null`
  (`agent-feed/sidecar/src/terminal/agentTerminalIdentity.ts:137`) -- plain opens join
  only. New kind `{kind:"tmux-new", session, directory}`; panel mints
  `agentterm-<8hex>`; sidecar validates name + `projectDirectory()` cwd; identity
  carries `createTmux: {cwd, command: []}` (empty = login shell). `-A` makes a name
  collision a join.
- **Kill needs a new route.** `close(mode:"kill")` on tmux only ends viewing
  (`tmuxAttachment.ts:228`). Primitive `killSessionArgs` exists
  (`tmuxSessionList.ts:216`). New `DELETE /api/tmux/sessions/:name`, validated.
- **Empty-parent source**: union per machine of live tmux dirs + IDE workspace roots
  (`GET /api/workspace/list`) + Bot environment dirs. All existing data, no storage.
- **Dropped deliberately**: per-child sizes (tiles are fixed 80x24, never claim);
  parent/child drag-reorder (nothing durable to rewrite; sort parents by path,
  children by name).

## Tasks

| ID | State | Task |
|---|---|---|
| T1 | D | Wire + sidecar: `tmux-new` context kind, identity resolution, `DELETE /api/tmux/sessions/:name`. Tests in the `agentTerminalRoutes` / `tmuxRoutes` patterns. No other sidecar changes -- listing, streams, attach reused. |
| T2 | D | Panel identity: shared hue/shade module generalized from `botSurface.ts` (rank whole cross-machine roster, never the visible strip); grouping selector (union roster per machine, residue parent); `terminalCanvasPreferences` (hidden parents, off-strip children, open keys). |
| T3 | D | Panel cards: `TerminalParentCard` (header, hue + 6px rail, add-terminal, menu), `TerminalChildCard` (closed row / open tile body verbatim, own open state), strip with reused scroll + zoom hooks, parent/child menus, kill-confirm dialog, add-terminal flow. Port notices/placeholder states. Drop SessionView, SourceBadge, fork/rename, faces, BotCreatorDialog, new-session cards. Way-back rows in-parent plus strip-end hidden-parents section. |
| T4 | D | Shell: per-machine feeds (`feedFor`, mirroring `botFeeds`), parent key = `machine:path`, mount where `TerminalsSurface` sits in `BrowserSurfaces.tsx`. Single-machine parity with no peers. |
| T5 | R | Replace the wall, verify (gates above + phone viewport: touch to keyboard to rail, new terminal lands in the right dir, kill confirms and lands, reload restores arrangement), land. |
