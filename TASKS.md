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
| R13 | R | Persist the text of a file autosave will not rescue -- conflicted, or last-write-failed -- with the revision it was typed against. |

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

What remains is R13, and it is smaller than "persist drafts" makes it sound, because autosave
already covers the ordinary case: an edit rests 900ms and is written, and closing a tab now waits
for that write rather than racing it.

Autosave has exactly two holes, and both are unbounded in time rather than 900ms wide:

- **A conflicted file never autosaves.** `edit` declines to schedule one, correctly -- the write
  would clobber the other side. So between the conflict appearing and the reader resolving it, that
  text is in React state and nowhere else.
- **A failed write is not retried.** It returns to `dirty` and waits for the next keystroke. The
  Swift did the same, so this is faithful rather than a port bug, but it has the same shape.

The Swift's `WorkspaceIDEFileDraftStore` also did something autosave cannot: each draft carried the
revision it was typed against, so reopening compared that to disk and restored the file *already
marked conflicted* if it had moved. Without that, a restart loses not just the text but the fact
that there was a divergence at all -- the reader is shown the file on disk with no sign their
version existed.

So the scope is a file whose text autosave will not rescue, which is usually none and occasionally
one, not every open tab.

**It does not belong in `localStorage`, and the count is not what decides that -- one draft can be
too big on its own.** Measured 2026-09-10 at the panel's dev origin in Chrome for Testing: a single
key holds 4MB and throws `QuotaExceededError` at 5MB. The text cap is 4MB, so one draft of a file
at the limit consumes the whole origin quota. The write itself is cheap (6ms for 4MB, so this is
not a jank argument), but every other thing the panel persists -- sidebar state, selection, the bot
canvas, usage, the IDE's own preferences -- shares that quota, and each of them wraps its write in
`try`/`catch` by house rule. They would not fail loudly. They would silently stop persisting, and
the reader's whole panel would quietly forget its arrangement because one large file was open.

The sidecar is the home, which is also where the Swift had it: `WorkspaceIDEFileDraftStore` wrote a
file per draft under Application Support, not into the webview. No quota, the atomic-write and
versioned-store patterns are already there in `workspaceStore.ts`, and a draft then follows the
reader between the phone and the Mac the way `orderedOpenPaths` does rather than resurrecting on
one surface only.

The open question that carries, and it is a decision rather than a detail: a sidecar draft is
**shared**, so two surfaces editing one path race for it. That is consistent with the open-tab and
expanded-directory state already being shared, and inconsistent with a draft being one reader's
private working copy. Settle it before writing the store, not after.

Worth knowing while sizing any of this: a 4MB file is not usable in the editor today regardless.
R11 records that `CodeEditor.tsx` is a textarea with no virtualisation, so it lays out every line.

One deliberate difference, recorded so it is not read as an oversight: the document cap is 32MB
where the Swift's was 100MB. The Swift's number was the QUIC frame budget, which no longer applies
over HTTP; 32MB is a fresh choice rather than the old one, and `AGENT_FEED_WORKSPACE_MAX_DOCUMENT_BYTES`
moves it.

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

## Not in this arc

- **Desktop assignment from the IDE sidebar.** ADR-0115 records why it leaves rather than moves.
- **Renaming `agent-feed/`.** The port that is still open, per `FEATURE-MAP.md`. Untouched here.
- **`WorkspaceFileViewer`.** The standalone `app://` viewer is a separate surface with a live
  consumer (`WorkspaceShell/Editor/FileViewer.swift`); R10 deletes only what the IDE owned.
