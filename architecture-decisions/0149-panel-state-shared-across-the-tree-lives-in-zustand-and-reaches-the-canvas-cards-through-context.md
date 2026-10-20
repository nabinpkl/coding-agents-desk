---
status: accepted
date: 2026-10-20
---

# Panel state shared across the tree lives in zustand, and reaches the canvas cards through context

## Context and Problem Statement

ADR-0146 named a home for reads, streams, state scoped to one value and stored preferences, and none
for the remaining case: state that two distant parts of the tree share, or a request one part makes
of another. Agents met that case and each solved it afresh. On 2026-10-20 the panel held ten stores
written by hand, each its own listener set, `subscribe` and `useSyncExternalStore` copied from the
file beside it, while zustand, already a dependency for stored preferences (ADR-0114), sat unused
for the job. The newest was a request from the Canvas tab's Sessions view to scroll the canvas to
one session's card: a module store holding the request, a five-second expiry, and a hook running on
every canvas render that searched the DOM for a `data-session-key` attribute until the card
appeared.

The other half of the same struggle was the canvas's props. `App` passed 36 props to `BotCanvas`.
Twenty-three of them were commands and per-card facts bound for the cards, which `BotCanvas` passed
on untouched and `BotCanvasList` passed on reading three of. Each was written three times per layer
(type, destructure, pass), so a new command meant editing four files, and an agent weighing a new
piece of canvas state weighed threading it through all of them.

## Decision Drivers

- The next agent copies whatever shape is nearest. Leaving no named shape for shared state produced
  ten copies of a hand-written one.
- A fact about one card must not re-render every card.
- The commands are the shell's. `useBotCommands`, `useCanvasRoster` and `useThreadSelection` serve
  the sidebar, the dialogs and the thread view as well as the canvas, and the roster prunes its
  open cards during render against the Bots it was just handed.
- A component renders in a test with what the test gives it, and a test never resets page-wide
  state by hand.

## Considered Options

- **Keep threading props**, and write a store by hand where props cannot reach.
- **Move the shell's commands and canvas state into one zustand store** that every surface reads.
- **zustand for state with no owner in the tree; context for what the shell owns and the canvas
  only reads.**

## Decision Outcome

Chose **zustand for unowned state, context for the shell's**.

- **State shared across the tree, or a request from one part to another, is a zustand store**:
  `createStore` from `zustand/vanilla`, read with `useStore` and a selector that returns a value,
  never a fresh object. A store a whole surface shares is made once by that surface's owner and
  handed down through a context (`createCanvasStore`, `CanvasStoreContext`), so each render of the
  app gets its own and a test needs no reset. A preference with one record for the whole page stays
  a module store, as `zoomMode`, `captureScale`, `overviewLayer`, `captureCrop`, `botFacesSwitch`,
  `terminalComposerPreference`, `keyboardBarState` and the Shiki highlighter now are.
- **One data source's state stays in `createSourceStore`**, which counts readers per source and is a
  different shape from one store. `useLimits` moved onto it.
- **The canvas's reveal is state the card answers**, not a search. The Sessions view sets
  `revealKey`; the session card's ref (`useRevealWhenAsked`) scrolls it when the key is its own,
  whether the card was drawn before the ask or after; and the reader pressing or scrolling the
  canvas drops a request whose card never came, in place of the clock. A Bot card defers to a reveal
  of one of its sessions, so a Bot wider than the canvas does not take the strip back to its edge.
- **The commands and per-card facts reach the cards through `CanvasShell`** (`canvasShell.tsx`):
  one context for the commands, which keep their identity, and one for the facts every card reads
  (which are open, which are off the canvas, a Bot's failure, started sessions, drafts, the session
  context by Bot). `App` builds both from the shell hooks and renders the provider around
  `BotCanvas`, which now takes only what the strip lays out. A session card still takes its
  commands bound by its Bot card, one layer, so it stays presentational.
- `eslint/no-restricted-imports` bans `useSyncExternalStore` from `react` in the panel's source
  outside `src/hooks/`, tests and `sourceStore.ts`, including the thirteen files ADR-0146 lets keep
  effects.

Moving the shell's commands into a store was rejected for now. They hold dialog state the shell's
dialogs read, and the roster's prune runs during render against the Bots it is handed: a store
there would be written during another component's render, which React refuses, or synced by an
effect, which is a second copy of the roster. Context carries the shell's state to the canvas
without either.

### Consequences

- Good, because a card reads what it needs, so `BotCanvas` dropped from 36 props to 13 and
  `BotCanvasList` from 32 to 9, and a new canvas command is one line in `CanvasActions` and one in
  `App`.
- Good, because a reveal re-renders the card it is about and its Bot card, not the canvas.
- Good, because the next store is copied from a zustand one, and the lint rule names it.
- Bad, because a component under `CanvasShell` throws when rendered without it. Every canvas test
  renders the app, which provides it.
- Bad, because the cards' facts context changes whenever any of them does, so every card re-renders
  on any open or close, as it did when they were props. Splitting it per fact is the move if that
  shows up in a profile.
- Neutral, because `audioChannelPlayer.ts` keeps its own listener set: it feeds a plain-DOM page,
  not React.

### Confirmation

Check 8 of `tools/agent-feed-fitness.sh` runs the ban on every `just check`.
`canvasStore.test.tsx` mounts a card after it is asked for, the order the page uses, and
`botCanvasRoster.test.tsx` presses "Show on canvas" and expects the session's own card to scroll;
it fails with the card's reveal ref removed.

## Links

- ADR-0146 (queries, named hooks and the effect ban)
- ADR-0114 (stored preferences onto zustand)
- zustand 5, https://github.com/pmndrs/zustand
