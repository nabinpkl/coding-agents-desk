---
status: proposed
date: 2026-09-07
---

# Keep the panel's remembered UI state in one store, and persist only what a reader arranged

## Context and Problem Statement

The Agent Panel remembers things across a reload because it is edited while it is being read: a
Vite save throws away every piece of React state many times an hour, and a phone whose webview is
discarded comes back the same way. Three different mechanisms now do that remembering, and a fourth
kind of state — the address bar — was added on 2026-09-07 for the sidebar's view.

- Hand-rolled `load*` / `store*` module pairs: `features/sidebar/selectionStore.ts`,
  `features/sidebar/sidebarPreferences.ts`, `features/bots/canvas/botCanvasPreferences.ts`, and the
  session memory inside `app/BrowserSurfaces.tsx`. Each one re-implements the same four things — a
  storage key, a `try`/`catch`, per-field validation of a possibly stale shape, and a default.
- `useSyncExternalStore` singletons: `features/terminal/terminalComposerPreference.ts`,
  `features/desktop-viewer/captureScale.ts`, `captureCrop.ts`, `zoomMode.ts`, `overviewLayer.ts`.
- One `zustand` store, `features/activity-feed/fontStore.ts`, which hand-rolls its own
  `localStorage` read and write rather than using the `persist` middleware.

`zustand` is already a dependency (`^5.0.13`), so this is a consolidation question rather than a
dependency question. What forces it now is that none of the hand-rolled modules has a version or a
migration: every one of them silently discards a reader's stored value the moment its shape changes,
and the number of shapes is growing — `sidebarPreferences` gained a third field on 2026-09-07 and
`botCanvasPreferences` gained a second concern the same day.

## Decision Drivers

- One pattern for one job. Three is how a reader ends up with a panel that remembers its font size
  and forgets its view, for reasons nobody can see from the code.
- A changed shape must be **migratable**, not merely survivable. Discarding a value is acceptable
  for a font size and not for a card layout somebody spent an evening arranging.
- Persistence must stay **opt-in per field**. A store that writes everything it holds is a store
  that resurrects transient state — a dialog left open, an in-flight error, a scroll position from
  a session that has since ended — and each of those comes back as a bug rather than as a
  convenience.
- No new dependency, and no new dependency gate.
- Must work with no `window`: the modules are imported by tests and by a container that may have
  none.

## Considered Options

- **Option A**: Keep hand-rolling a `load*` / `store*` pair per feature.
- **Option B**: One `zustand` store per concern, with the `persist` middleware and `partialize`.
- **Option C**: `jotai` with `atomWithStorage`.
- **Option D**: Put the state in the address bar instead.

## Decision Outcome

Chose **Option B**. It is the only option that gives a migration story (`version` + `migrate`) for
state a reader would be annoyed to lose, and it costs nothing to adopt because the dependency is
already installed and already used once. Option A was knocked out by the migration driver: four
copies of a validator is four places to write a migration, which is why none of them has one.
Option C would satisfy every driver equally well but fails the dependency driver for no gain over a
package already in the tree. Option D fails the opt-in driver from the other end — an address that
carried the open card would carry an absolute project path and a session id, and it was already
rejected for the sidebar view's deeper state on 2026-09-07 for that reason.

The half of this decision that matters more than the library is the rule for **what gets
persisted**, because `persist` will happily write everything a store holds:

> Persist a fact about how **this reader arranged the panel**, which would cost them real work to
> re-establish after a reload. Do not persist anything the sidecar already knows, anything derivable
> from what it sends, or anything whose absence a reader cannot see.

The last clause is the one with a scar behind it: which Bots are on the canvas is deliberately NOT
stored (`AgentPanelApp.tsx`, `detachedBotIds`), because a canvas that comes back whole costs one
click to arrange again, where one that comes back missing a Bot hides it from a reader who has
forgotten they took it off. Cheap to redo beats quietly wrong.

### Consequences

- Good, because a shape change becomes a migration rather than a silent reset, which is what makes
  it safe to keep adding fields to a reader's remembered layout.
- Good, because the four hand-rolled validators collapse into one place, and the next piece of
  remembered state is a field rather than a module.
- Bad, because `persist` makes writing easy enough that the opt-in rule above has to be enforced by
  review rather than by friction. The rule is therefore written into `AGENTS.md` rather than left
  in this ADR.
- Neutral, because the address bar keeps its own job: it carries what a **link** should carry — the
  surface (`entry`) and the sidebar view (`view`) — and nothing deeper. A store and an address are
  not competing mechanisms; they answer different questions.

### Confirmation

Every persisted store declares a `version`, and its module has a test that loads a value written at
the previous version and asserts what the reader gets. The observable signal that the migration is
finished is that no `localStorage` call site remains outside the store modules and
`app/BrowserSurfaces.tsx`; `tools/agent-feed-fitness.sh` is where that check belongs if it is worth
automating.

### Migration order

Deliberately last-to-first by risk, so the pattern is proven on state nobody would miss before it
touches state somebody arranged:

1. `terminalComposerPreference` and the four desktop-viewer singletons — a boolean and four
   enums, no shape to migrate, and they already expose a store-shaped API.
2. `fontStore` — already `zustand`; replace its hand-rolled read and write with `persist`.
3. `sidebarPreferences` and `sidebarRoute`'s storage fallback — one object, three fields, a shape
   that has already changed once.
4. `selectionStore` and `botCanvasPreferences` — the two that hold a reader's arrangement, moved
   only once a migration has been written and tested for each.

`BrowserSurfaces`' session memory stays where it is: it is read before React mounts, to avoid
opening every reload on the default session and then jumping.

## Links

- ADR-0095, ADR-0096 — the live dev origin, which is why a reload is frequent enough for any of
  this to matter
- `packages/AgentPanel/Web/src/features/sidebar/sidebarRoute.ts` — why the address carries the view
  as a query parameter and not a path segment
- zustand `persist` middleware, v5 docs (`partialize`, `version`, `migrate`, `createJSONStorage`),
  read 2026-09-07
