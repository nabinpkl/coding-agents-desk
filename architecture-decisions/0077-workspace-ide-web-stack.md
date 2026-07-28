---
status: accepted
date: 2026-07-27
---

# Build the workspace IDE surface on Vite, TypeScript and Tailwind, and defer React

## Context and Problem Statement

`packages/WorkspaceIDE/Web` renders both webview surfaces the workspace IDE ships: the standalone
file viewer bundled into `WorkspaceFileViewer`, and the sidebar and editor regions bundled into
`WorkspaceIDE`. It grew as hand-rolled ES modules bundled by a bespoke esbuild script, styled by a
400-line stylesheet of named classes, with no type checking. Meanwhile `gesture-agent/web` — the
phone agent surface in the same repo — runs React, Vite, Tailwind, shadcn and Zustand, so the
question of whether the two should converge is live rather than theoretical.

The forcing event was a week of layout bugs whose root causes were structural: a shared stylesheet's
`body { display: flex }` reaching a document that laid itself out, a `const` read before its
initialiser at module-eval time, and grid children sliding rows whenever a hidden sibling stopped
being a grid item. Verifying any of them meant copying built bundles into a scratch directory and
serving them by hand.

## Decision Drivers

- Both documents load in a `WKWebView` over the `app://` custom scheme under a strict CSP, offline,
  from committed Swift package resources. Anything the build emits must satisfy that.
- The authoritative IDE state lives in Swift (`WorkspaceIDEController`): selection, open files,
  drafts, zoom. The webview receives projections and posts intents. One authoritative home per
  piece of state is a standing repo rule.
- The recurring defect class in this repo is silent wire drift across the Swift/JS boundary, where
  per-side tests each pass.
- Seeing a change on screen must be cheap, or visual regressions will keep being found by the human
  rather than by the person who wrote them.
- Divergence between the repo's two web surfaces has a real cost in build systems, test idioms and
  conventions.

## Considered Options

- **Option A**: Keep hand-rolled ESM and esbuild; fix each bug where it appears.
- **Option B**: Adopt the full `gesture-agent/web` stack now — Vite, TypeScript, Tailwind, React,
  Zustand, shadcn.
- **Option C**: Adopt Vite, TypeScript and Tailwind; defer React, Zustand and shadcn behind named
  triggers.

## Decision Outcome

Chose **Option C**. Option A was knocked out by the verification driver: two of the week's bugs were
structurally preventable (scoped styles, a type checker) and the absence of a dev server made every
visual check a manual ritual. Option B was knocked out by the state-ownership driver: Zustand would
create a second authoritative copy of state that Swift already owns, which is the drift this repo
explicitly forbids, and shadcn is a Radix-and-Tailwind app-component library whose dialogs and
dropdowns have little overlap with IDE chrome — tree rows, tabs, an activity bar — which is almost
entirely custom.

React itself is deferred rather than rejected. At the time of writing the surface is roughly 550
lines across one module per component, each exporting `(data, send) => Element`. That signature is
deliberately the shape of a function component, so the eventual port is close to mechanical.

### The trigger for React

Adopt React when the region accumulates a **third** piece of module-level view state that exists
only to survive a full re-render. There is one today: `collapsedSourceGroups` in
`src/sidebar/sourceControl.ts`, a `Set` hoisted out of the render because collapsing a group would
otherwise spring back open on the next projection. One is fine. Three means a hand-rolled
reconciler, and the real one is cheaper.

Concretely, features likely to cross that line: inline rename, a context menu, drag-reorder inside
the tree, or multi-select. When React is adopted, take props from the projection — not a store.
Zustand and shadcn remain separately justified decisions, not consequences of taking React.

### Consequences

- Good, because the wire contract is written down for the first time (`src/projection.ts`),
  including the abbreviated CodingKeys that make a drift against Swift silent rather than loud.
- Good, because `vite dev` replaces the copy-a-bundle-and-serve-it ritual.
- Good, because the repo now has one web stack rather than two unrelated ones, even though the two
  surfaces sit at different points on it.
- Bad, because two build systems still exist in the tree — this package's two-document Vite build
  and `gesture-agent/web`'s Next-based one — and they will drift unless someone reconciles them.
- Neutral, because tests stay dependency-free: Node 24 strips types natively, so
  `node --test test/*.ts` runs without a test framework or a transpile step.

### Confirmation

- `just workspace-ide-fitness` asserts each published tree is a self-contained `index.html` plus
  `assets/`, and that no `node_modules` reaches Swift package resources.
- `test/workspaceZoom.test.ts` asserts each entry pulls in exactly one stylesheet that lays its
  document out, and that `viewer.css` reaches the viewer entry and nothing else.
- `test/ideStyles.test.ts` asserts every region pins its scrolling pane to the growable grid row,
  which is the failure mode that produced two of the bugs behind this ADR.
- The React trigger is observable by grepping for module-level mutable state in `src/sidebar` and
  `src/editor`; when the count reaches three, this ADR is due a successor.

## Links

- ADR-0054 shared WKWebView viewer SPA runtime
- `packages/WorkspaceIDE/Web/vite.config.mjs` — the `app://` scheme constraints, in code
- `packages/WorkspaceIDE/Web/src/projection.ts` — the wire contract this ADR introduced
