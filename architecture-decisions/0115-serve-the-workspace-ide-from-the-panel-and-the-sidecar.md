---
status: accepted
date: 2026-09-10
supersedes: 0077
---

# Serve the workspace IDE from the Agent Panel and the sidecar

## Context and Problem Statement

The workspace IDE is the last first-party surface still on the compile path. Its two documents
(`packages/WorkspaceIDE/Web`) build through a bespoke two-entry Vite script into **committed Swift
package resources**, which an `app://` scheme handler serves into two `WKWebView`s inside an AppKit
split view. Its state authority, file IO, git status and terminal are all Swift, in
`packages/WorkspaceIDE/Sources` and `host/AgentDeskHost/Workspace*`.

So an edit reaches the running IDE by: vite build, copy into Swift resources, rebuild the host,
relaunch it. Every other live surface reaches its reader by a page reload. The surface has not been
touched since 2026-08-02, and `FEATURE-MAP.md` lists it dormant. Reviving it on the current path
means answering where its code and its state should live, because the two questions have one answer.

ADR-0077 decided the opposite of this, deliberately and with reasons. It is superseded rather than
contradicted: its state-ownership driver was correct for a surface whose authority was a Swift
controller, and this ADR moves the authority rather than duplicating it. Its React trigger has
fired -- a revived surface adds inline rename, a context menu and drag-reorder, which it named --
and its "wire drift across the Swift/JS boundary" driver is answered by deleting the boundary.

## Decision Drivers

- Zero recompilation, zero reinstall, zero relaunch is the standing target for first-party glue
  (`AGENTS.md`, "TypeScript-first glue and logging"). A proposed Swift change has to name the
  native capability TypeScript cannot provide.
- One authoritative home per piece of state. Whatever moves must move, not be copied.
- The panel already owns four surfaces, a terminal over tmux, a markdown renderer, a shiki
  highlighter and a mermaid block. A second implementation of any of those is the duplication this
  repo's conventions exist to stop.
- The IDE's file service is currently reachable only from a local webview and a device-authenticated
  QUIC lane. The sidecar has no authentication at all; its boundary is the bind address plus
  WireGuard. Moving file **write** into it widens exposure and has to be paid for in validation.
- The `＋ IDE` window is a real product affordance: an IDE pinned to a Desktop is not a tab in a
  panel. Window placement is already owned by ADR-0092 and belongs in Swift.

## Considered Options

- **Option A**: point the two existing `WKWebView`s at the Vite dev origin, keep the Swift backend.
- **Option B**: panel surface with a sidecar backend, delete the native window.
- **Option C**: panel surface with a sidecar backend, keep the native window as a thin container.

## Decision Outcome

Chose **Option C**.

Option A was knocked out by arithmetic: it buys HMR for the two region documents and leaves the
state authority, file IO, git and terminal behind a host rebuild, which is where most IDE behaviour
lives. It also costs native work on the scheme handler and the CSP to get that half, and the thing
being paid for is not needing to rebuild the host.

Option B was knocked out by the window driver. Nothing else in the panel replaces a floating IDE
pinned to a Desktop, and the placement code that does it already exists and is correct.

### What moves, and where

| Piece | From | To |
|---|---|---|
| Path validation, file read/list/write | `WorkspaceFileService`, `WorkspaceFilePOSIX` | `sidecar/src/workspace/` |
| Open tabs, expanded directories, revisions | `WorkspaceIDEStateCoordinator` | `sidecar/src/workspace/workspaceSharedState.ts` |
| Workspace roster | `WorkspaceStore` | `sidecar/src/workspace/workspaceStore.ts` |
| Git status | `WorkspaceObservationCoordinator` | `sidecar/src/workspace/workspaceGit.ts` |
| Selection, drafts, zoom, pane sizes | `WorkspaceIDELocalState` (UserDefaults) | panel storage, per `AGENTS.md` "Panel state" |
| Sidebar and editor regions | two `WKWebView`s on `app://` | one panel feature at `?entry=ide` |
| Layout and dividers | `WorkspaceIDEWindowContentView`, `WorkspaceIDEPaneDivider` | CSS |
| Terminal pane | `WorkspaceIDETerminalBackend` -> PtyClientSwift | the panel's existing `features/terminal` |
| Window, Desktop assignment, restore | `WorkspaceIDEWindowRegistry`, `WindowController` | unchanged, Swift, ADR-0092 |

The window selects the surface the way the iOS client already selects the desktop viewer: a
`WKUserScript` setting `window.__agentPanelEntry` at document start. It is not a URL query, and it
needs no change to WebPanelKit.

### Deliberate scope reductions

- **Desktop assignment leaves the IDE sidebar.** It was a workspace-level Spaces concern reached
  through the IDE's own capability set; Desktop placement has one authority (ADR-0092) and the panel
  reaches it through `features/desktop-park`. The IDE's `WorkspaceIDEPlatformCapabilities` collapses
  to what the sidecar can actually do.
- **The QUIC workspace lane is deleted, not ported.** It served the iOS client, which is dormant;
  mobile is the same browser panel now.
- **markdown-it and the second mermaid go.** The panel's `features/activity-feed/markdown` already
  renders markdown, mermaid and highlighted code. CodeMirror is the only genuinely new dependency,
  because shiki highlights and does not edit.

### Consequences

- Good, because the wire stops being written twice. `Web/src/projection.ts` existed to mirror Swift
  `CodingKeys`, and ADR-0077's headline consequence was writing that drift class down. There is now
  one definition in `agent-feed/wire/workspaceIde.ts` and nothing to drift against.
- Good, because the IDE gains the panel's session picker for free: it answers whichever sidecar the
  reader picked, like every other surface.
- Bad, because the descriptor-relative `openat` walk does not survive the port. Node has no
  `openat`, so the TypeScript walk validates each component with `lstat` and opens the leaf
  `O_NOFOLLOW`. A symlink is still refused at every component; what is lost is atomicity between the
  check and the open. The residual attacker is one who can already create symlinks inside a
  registered workspace root, mid-request.
- Bad, because file write now sits behind an unauthenticated bind address. The validation is the
  only thing standing between the tailnet and the filesystem, which is why it is tested first and
  separately.
- Neutral, because the IDE stops being in `just swift-check` and starts being in `just check`.

## Confirmation

- `workspacePaths.test.ts` is the security gate: absolute paths, `..`, `.`, empty components,
  embedded NUL, and a symlinked component all refuse before any IO.
- `workspaceSharedState.test.ts` holds the revision and idempotency semantics ported from
  `WorkspaceIDEStateCoordinator`: a replayed operation ID is a no-op, a stale base revision
  conflicts, and a reorder that is not a permutation is refused.
- The surface is reachable at `?entry=ide` in a browser tab and from the `＋ IDE` window, and both
  reach the same sidecar state.

## Links

- ADR-0077 the stack this supersedes, and the React trigger it named
- ADR-0092 Desktop window-placement authority, which the window keeps
- ADR-0096 runtime live/bundled panel switching, which the entry script rides on
- ADR-0108 the precedent: agent terminals moved into the panel the same way
