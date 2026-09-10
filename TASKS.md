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
