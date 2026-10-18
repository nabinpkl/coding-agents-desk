---
status: accepted
date: 2026-10-18
---

# The panel reads data through queries and stores, and bans effects outside named hooks

## Context and Problem Statement

On 2026-10-18 `packages/AgentPanel/Web/src` held 310 `useEffect`/`useLayoutEffect` calls in 138
files. Classified by what each one did: 68 only set state from other state, 31 fetched once with
their own cancel flag, 29 opened a stream, 16 wrote a value to storage after it changed, 13 told a
parent about a value, 15 copied a prop into a ref, 15 synced a `<dialog>`'s `showModal`, and the
rest kept something outside React in step (listeners, observers, timers, focus and scroll, xterm,
WebRTC, pdf.js). Most were copied from the file next door, because nothing said which shape a
new one should take. ADR-0077 had deferred a data library for the IDE webview when Swift owned
its state; the panel has since become the main app, its data comes from the sidecar, and that
deferral was never revisited.

## Decision Drivers

- A one-off read should not need its own cancel flag, error state and reset effect.
- A hot swap of the data source (`main.tsx`) must refetch and resubscribe, not serve or stay on
  the replaced source.
- An effect is the hardest code in the panel to read, because its timing is implicit; the next
  agent should copy a shape that names what it does.
- No change in what the reader sees.

## Considered Options

- **Keep effects, gate `exhaustive-deps`.** Catches stale dependencies, leaves every shape above.
- **TanStack Query for reads, named hooks for everything else, a lint ban on effects anywhere
  else.**
- **TanStack Query for streams too** (`experimental_streamedQuery`). A query stays "fetching" until
  its stream ends, and the sidecar's streams never end.

## Decision Outcome

Chose **queries, named hooks and the ban**.

- **One-off reads** use `usePanelQuery` (`@/query/panelQuery`): TanStack Query 5 against one
  module-level `QueryClient` passed to each hook instead of a provider, so a component renders the
  same in a test with nothing around it. Every key carries `sourceKey(<the object read from>)`, so
  a rebuilt data source is a new key. `retry` and window-focus refetch are off, which is what the
  effects did. The sidecar's config is one shared query (`@/query/sidecarConfig`).
- **State that belongs to one value of something else** -- a form for one opening, a highlighted
  row for one query, a draft for one session -- is `useStateFor(scope, initial)`, which starts over
  during the render that sees a new scope. A one-off correction to state is made during render
  too (React's "adjusting state when a prop changes"), never in an effect.
- **Stored preferences** are written from their setter (`usePersistentState`).
- **Everything that keeps something outside React in step** goes through a hook in `src/hooks/`
  named for what it is: `useSubscription` (a stream, keyed by a string naming what it is to),
  `useEventListener`, `useResizeObserver`, `useIntersecting`, `useMediaQuery`, `usePageVisible`,
  `useInterval`/`useTimeout`, `useMountEffect`/`useUnmountEffect`/`useLeaveEffect`, `useLatestRef`,
  the overlay hooks (`useDismissOnOutsidePress`, `useOverlayPlacement`, `useModal`), ref callbacks
  (`modalWhileMounted`, `focusOnMount`, `selectOnMount`), and `useDomSync` for DOM work that must
  land before paint.
- **`useNotify`** tells a parent, or something outside React, about a value only this component
  holds. It is the shape React's docs steer away from, kept in one named place so each of its
  callers is a visible candidate for moving the state up or into a store.
- **Thirteen files keep effects of their own**, each driving one outside system whose objects run
  until they are cancelled or destroyed: pdf.js (`usePdfJs.ts`), a tmux pane's and a Mac window's
  composer (`useTmuxComposer.ts`, `useWindowComposer.ts`), the transcript's virtualiser
  (`useTranscriptScrollRestore.ts`, `useGapFill.ts`, `useOlderPageAnchor.ts`), the two canvases'
  scroll restore (`useRememberedCanvasScroll.ts`, `useTerminalCanvasScroll.ts`), xterm
  (`useAgentTerminal.ts`), WebRTC (`TileStreamRtc.tsx`) and the far Mac's pointer
  (`TileViewport.tsx`, `useTrackpadGestures.ts`, `useScrollStripGestures.ts`). Each is listed in
  `.oxlintrc.json` with the system it drives.
- `eslint/no-restricted-imports` bans `useEffect`, `useLayoutEffect` and `useInsertionEffect` from
  `react` everywhere else in the panel's source except tests. A `React.useEffect` reached through a
  namespace import is caught by check 8 of `tools/agent-feed-fitness.sh`.

Measured once the port was done: 41 effect calls outside tests (15 in `src/hooks/`, 26 in the
thirteen named files), from 310. The approved hooks are called about 360 times, the largest
being `useStateFor` (93), `useDomSync` (43), `useEventListener` (37), `useSubscription` (23),
`usePanelQuery` (20) and `useNotify` (20).

`exhaustive-deps` alone was rejected because it keeps all 310 effects, each still a place a reader
has to simulate. Streamed queries were rejected on the never-ending stream; streams stay in
`createSourceStore` (reader-counted, one entry per data source) or `useSubscription`.

### Consequences

- Good, because a read is one call with its loading and error state, three surfaces asking for the
  sidecar's config share one request, and a hot swap refetches by construction.
- Good, because a reset that used to draw one frame of the old value now happens in the render
  that sees the change.
- Good, because an effect can no longer be added by copying a neighbour; the lint message names
  the replacements.
- Bad, because `useDomSync` and `useNotify` are effects with a narrower contract, and the contract
  is enforced by review, not by the linter. Their call sites are the place to look first when this
  decision is revisited.
- Bad, because `useMountEffect` cannot follow a changing value: what must restart on a change is a
  `useSubscription` key, a query key or a `useStateFor` scope, which is more structure than a
  dependency list.
- Neutral, because a test that flushed one promise for an effect's answer now gets TanStack Query's
  notification on a microtask (`notifyManager.setScheduler(queueMicrotask)` in the test setup),
  and two that waited a fixed tick wait for the element instead.
- Neutral, because `app/agentPanelAppMocks.tsx`, the `vi.mock` factories the App's tests load,
  imports React dynamically and is outside the rule's view, like the tests it serves.

### Confirmation

Check 8 of `tools/agent-feed-fitness.sh` runs the ban on every `just check`. A new file under
`src/features` that imports `useEffect` fails it with a message naming the replacements.

## Links

- ADR-0077 (deferred a data library for the IDE webview)
- ADR-0114 (stored preferences onto zustand `persist`)
- TanStack Query 5.104.1, https://tanstack.com/query/latest (released 2026-10-02)
- React, "You Might Not Need an Effect", https://react.dev/learn/you-might-not-need-an-effect (no date verifiable)
