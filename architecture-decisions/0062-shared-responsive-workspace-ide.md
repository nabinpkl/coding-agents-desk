---
status: accepted
date: 2026-07-19
supersedes: ADR-0054
---

# Embed one responsive workspace IDE in two native pane shells

## Context and Problem Statement

ADR-0054 deliberately shared workspace data while keeping macOS and iPhone navigation separate. That
boundary avoided premature presentation sharing, but it now leaves two implementations of the same
workbench behavior: workspace selection, recursive exploration, Git status, tabs, file rendering, and
editing. ADR-0061 also established that the terminal is a native, persistent workspace resource whose
layout and lifecycle belong to the platform shell. The next workspace surface needs presentation
parity without moving filesystem or PTY authority into JavaScript.

## Decision Drivers

- Keep registered roots, revisions, Git reads, observation, and PTY lifecycle authoritative on the Mac.
- Use one authored implementation for Explorer, Source Control, tabs, and file rendering on both platforms.
- Preserve native split geometry, keyboard avoidance, accessibility, and focus behavior.
- Share tab membership and expanded directories without synchronizing device-local navigation or drafts.
- Retain the current native Workspace surfaces during the rollout.

## Considered Options

- Continue extending the independent AppKit and UIKit workspace presentations.
- Put the entire IDE, including terminal layout, in one WKWebView.
- Use two region-specific WKWebViews coordinated by one native state owner, with native SwiftTerm below the editor.

## Decision Outcome

Choose two region-specific WKWebViews inside a native split container. A shared `WorkspaceIDEController`
owns both webviews, decodes their intents, serializes data-source work, rejects stale generations, and
projects one authoritative snapshot into each region. The webviews load one bundled application with an
explicit `sidebar` or `editor` bootstrap. They never communicate through `localStorage` and never call
transport APIs directly.

The native AppKit and UIKit containers own a full-height sidebar region and a right column containing
the editor, an accessible divider, and native SwiftTerm. Hiding or resizing a pane retains its webview
and terminal instances. The host exposes the same coordinator contract through an in-process adapter on
macOS and an authenticated workspace-lane adapter on iPhone.

The host persists a revisioned shared state per workspace containing ordered open paths and expanded
directory paths. Selected workspace, active tab, sidebar section, pane visibility, pane sizes, drafts,
and editor cursor positions remain device-local. A dirty local tab is protected from a remote close.

The `.files` stream becomes a typed workspace lane while retaining its binary property-list codec and
101 MiB frame bound. It carries file requests plus IDE state, Git status, and workspace-change messages.
This coordinated wire change requires AgentDesk protocol v11 with no v10 compatibility path. DOCX data
remains binary and is exposed to WebKit through an `app://` resource URL.

This supersedes only ADR-0054's decision to keep platform workspace presentation independent. Its
shared data boundary, host ownership, registered-root confinement, and donor-retirement decisions remain.
ADR-0061's native workbench and host-resolved terminal decisions also remain; this ADR extends that
composition to macOS and replaces the sidebar/editor presentation inside the new IDE entry only.

### Consequences

- Good, because Explorer, Source Control, tabs, editing, DOCX behavior, and accessibility semantics have one authored implementation.
- Good, because two webviews are projections of one typed coordinator instead of independent applications.
- Good, because terminal and filesystem authority stay native and host-owned.
- Bad, because a single logical workspace surface now coordinates two WebKit lifecycles and unsolicited host pushes.
- Bad, because protocol v11 requires host and client to land together.
- Neutral, because the existing native Workspace surfaces remain available while the IDE entry proves itself.

### Confirmation

Tests must prove identical sidebar/editor projections, strict intent parsing, generation fencing, shared
state idempotency, local draft/conflict behavior, one observation per generation, protocol v11 rejection
of v10, and byte-exact DOCX transfer at the existing boundary. Live verification happens only after the
repository launch checkpoint and checks both platforms, pane retention, terminal confinement, shared
tabs/folders, conflicts, external changes, Git status, and DOCX viewport restoration.

## Links

- ADR-0052 AgentDesk owns the agent workspace
- ADR-0054 shared workspace foundation and platform presentation
- ADR-0057 shared responsive DOCX preview
- ADR-0061 iOS workspace workbench terminal
- `tasks/2026-07-19-v14-shared-workspace-ide.md`
