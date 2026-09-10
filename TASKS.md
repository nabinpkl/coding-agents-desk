# v17 workspace IDE on the live path

Opened 2026-09-10. ADR-0115 is the decision; this is the order it lands in.

The IDE is the last first-party surface on the compile path. It moves to the panel (Vite, live) and
the sidecar (`bun --watch`, live), keeping the `＋ IDE` window as a thin native container.

Gates: `just check` for every task, `just swift-check` additionally for R7-R9.

## Tasks

| ID | State | Task |
|---|---|---|
| R1 | D | ADR-0115 and this ledger. |
| R2 | R | `agent-feed/wire/workspaceIde.ts`: one definition of the IDE contract, exported from the wire index. |
| R3 | R | `sidecar/src/workspace/workspacePaths.ts`: the security core. Component validation and a symlink-refusing walk, tested before anything calls it. |
| R4 | R | `sidecar/src/workspace/workspaceFiles.ts`: list, read, write, atomic rename, sha256 revisions, the 12-case failure taxonomy. |
| R5 | R | `sidecar/src/workspace/workspaceStore.ts` and `workspaceSharedState.ts`: the roster, and the open-tab/expanded-directory state with revisions and operation idempotency. |
| R6 | R | `sidecar/src/workspace/workspaceGit.ts` and `http/workspace-routes/`: git status, the routes, the SSE stream, registration in `server.ts`. |
| R7 | R | `panel/src/features/workspace-ide/`: the surface. Sidebar, editor, tabs, preview, reusing `features/terminal` and `features/activity-feed/markdown`. |
| R8 | R | `?entry=ide`: `panelEntry.ts`, `main.tsx`, `BrowserSurfaces.tsx`. |
| R9 | R | The `＋ IDE` window becomes one `AgentPanelWebViewController` with an entry user script. Dividers, region webviews and the PTY terminal pane go. |
| R10 | R | Delete `packages/WorkspaceIDE/Web`, the committed resource trees, the QUIC workspace lane, and the `workspace-ide-*` justfile recipes. |

## Not in this arc

- **Desktop assignment from the IDE sidebar.** ADR-0115 records why it leaves rather than moves.
- **Renaming `agent-feed/`.** The port that is still open, per `FEATURE-MAP.md`. Untouched here.
- **`WorkspaceFileViewer`.** The standalone `app://` viewer is a separate surface; R10 deletes only
  what the IDE owned.
