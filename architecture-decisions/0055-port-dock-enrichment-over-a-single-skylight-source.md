---
status: accepted
date: 2026-07-12
---

# Port the dock-enrichment strip, backed by a single SkyLight source

## Context and Problem Statement

[ADR-0054](0054-shared-workspace-foundation-and-macos-reveal-chrome-port.md) ported the
agent-workspace-ide shell into the host but deliberately left **dock enrichment** (the donor's third,
bottom overlay) and **desktop/Space auditing** out of scope, narrowing the reveal surfaces to
`{ sidebar, topBar }`. This ADR reopens that one boundary: the dock-enrichment strip is now ported.
It does not disturb ADR-0054's other decisions; it revises only the dock-enrichment/desktop-audit line
of that ADR's scope boundary.

Dock enrichment is a bottom-edge auto-hide strip showing one "desktop pill" per macOS Desktop, each
carrying the app icons running on that Desktop, with hover tooltips and a right-click popover listing
each app's windows. Grouping apps by Desktop needs a per-window→Space mapping, which the donor read
through its **own** SkyLight binding (`SkyLightDesktopBinding`). The host already owns a SkyLight
binding in `SpacesProvider` (guarded by the `SpacesProvider` smoke test, the canary for private-API
drift). Standing up the donor's parallel binding would mean two independent private-API consumers.

## Decision

Port the donor's dock model, reader, and panel into `host/AgentDeskHost/WorkspaceShell/Dock/`, and add
the bottom strip as a third reveal surface (`WorkspaceShellSurface.dockEnrichment`, `.bottom` edge)
over the existing `WorkspaceShellOverlay`/reveal state machine. Two choices shape it:

1. **One SkyLight source, not two.** Extend the host's existing `SpacesProvider` binding with the one
   missing symbol (`SLSCopySpacesForWindows`/`CGSCopySpacesForWindows`, resolved optionally) and expose
   a `nonisolated skyLightDesktopAuditSnapshot()` that composes the desktop + window audit from
   SkyLight + `CGWindowList` only (no `NSScreen`, so it is safe on the reader's utility queue).
   `HostWorkspaceDesktopAudit` backs the reader's `WorkspaceDesktopAuditing` onto it. The donor's
   `SkyLightWorkspaceDesktopAudit` / `SkyLightDesktopBinding` are **not** ported. (Chosen over porting
   the donor audit verbatim: fewer private-API surfaces to drift, one canary.)

2. **Pill labels follow the workspace, not the Desktop ordinal.** The reader stays workspace-agnostic
   and emits a 1-based `"Desktop N"` base label off-main; the panel overlays the assigned workspace's
   name on the main thread (where the store lives) via an injected label provider, falling back to
   `"Desktop N"` for unassigned Desktops. (Chosen over the donor's generic ordinal labels: agent-desk
   is workspace=desktop, and the group model already carried a `label` field for exactly this.)

## Consequences

- **Private-API surface grows by one symbol on the existing binding**, not by a whole second binding.
  If a future macOS drops `CopySpacesForWindows`, the enrichment degrades to ungrouped (the symbol is
  optional) rather than breaking `SpacesProvider`.
- **Overlaps SpaceAgent.** The host already shows Desktops as top-center tiles (SpaceAgent); this adds a
  second, differently-shaped Desktop overview at the bottom. Accepted as a distinct affordance (app/
  window inventory vs. Space-switch tiles); revisit if the two feel redundant in use.
- **Bottom-edge placement can overlap the dictation bar** (bottom-center, on-demand). Both are
  auto-hide/ephemeral, so the overlap is transient; not resolved here.
- The shell's own overlay panels are titled (`WorkspaceShellControlWindow`) so the reader filters them
  out of the enrichment view.
- Reveal surfaces widen back to `{ sidebar, topBar, dockEnrichment }`, revising ADR-0054's narrowing.

Still left behind from ADR-0054 (unchanged): ShellBook, tenants/chrome-borrow window placement,
notebooks/Jupyter, and the donor's own desktop-audit binding.
