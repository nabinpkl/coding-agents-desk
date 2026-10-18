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
- A hot swap of the data source (`main.tsx`) must refetch, not serve the replaced source's answer.
- An effect is the hardest code in the panel to read, because its timing is implicit; the next
  agent should copy a shape that names what it does.
- No change in what the reader sees.

## Considered Options

- **Keep effects, gate `exhaustive-deps`.** Catches stale dependencies, leaves every shape above.
- **TanStack Query for reads, stores for streams, a lint ban on effects outside approved hooks.**
- **TanStack Query for streams too** (`experimental_streamedQuery`). A query stays "fetching" until
  its stream ends, and the sidecar's streams never end.

## Decision Outcome

Chose **queries, stores and the ban**.

- **One-off reads** use `usePanelQuery` (`@/query/panelQuery`), TanStack Query 5 against one
  module-level `QueryClient` passed to each hook instead of a provider, so a component renders the
  same in a test with nothing around it. Every key starts with `sourceKey(<the object read from>)`,
  so a rebuilt data source is a new key. `retry` and window-focus refetch are off, which is what
  the effects did.
- **Streams** stay in `createSourceStore` (one entry per data source, reader-counted), read with
  `useSyncExternalStore`; the store opens a stream when its first reader subscribes.
- **Everything else** goes to the render (derived values, `key` to reset), the event handler, a
  ref callback, `usePersistentState` (writes storage from its setter), or a hook in `src/hooks/`
  named for the outside thing it keeps in step: `useEventListener`, `useResizeObserver`,
  `useInterval`/`useTimeout`, `useMountEffect`/`useUnmountEffect`, `useLatestRef`.
- `eslint/no-restricted-imports` bans `useEffect`, `useLayoutEffect` and `useInsertionEffect`
  from `react` everywhere in the panel's source except `src/hooks/` and tests. A
  `React.useEffect` reached through a namespace import is caught by check 8 of
  `tools/agent-feed-fitness.sh`.

`exhaustive-deps` alone was rejected because it keeps all 310 effects, each still a place a reader
has to simulate. Streamed queries were rejected on the never-ending stream.

### Consequences

- Good, because a read is one call with its loading and error state, three components asking for
  the sidecar's config share one request, and a hot swap refetches by construction.
- Good, because an effect can no longer be added by copying a neighbour; the lint message names
  the replacements.
- Bad, because `useMountEffect` with no dependencies cannot follow a changing value: what must
  restart on a change has to be a remount, a query key or a store, which is more structure than an
  effect with a dependency list.
- Neutral, because the panel's AGENTS.md rule "write storage from an effect on the value" becomes
  "write it from the setter `usePersistentState` returns": still one place.

### Confirmation

Check 8 of `tools/agent-feed-fitness.sh` runs the ban on every `just check`; `src/hooks/` holds the
only effects in the panel's source.

## Links

- ADR-0077 (deferred a data library for the IDE webview)
- ADR-0114 (stored preferences onto zustand `persist`)
- TanStack Query 5.104.1, https://tanstack.com/query/latest (released 2026-10-02)
- React, "You Might Not Need an Effect", https://react.dev/learn/you-might-not-need-an-effect (no date verifiable)
