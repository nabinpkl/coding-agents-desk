# Agent Panel: how to work in `packages/AgentPanel/Web`

The repository root `AGENTS.md` still applies here. This file holds what matters only once you are
changing or reading the panel. Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged.
Verifying a panel change in a browser: `docs/agents/browser-testing.md`.

## Scroll and slide direction

**Not implemented on any live surface today** -- it was the native client's, and the browser panel's
desktop navigation does not commit a direction from a finger yet. Recorded because it is a product
decision rather than an implementation detail, and whoever builds it next should not have to
re-derive it.

Horizontal slides that move between desktops use the **opposite of Mac native** by default: sliding
the finger left-to-right brings the LEFT-neighbour desktop into focus. The Mac-native mapping is the
opt-in toggle. The default is load-bearing for the rest-state metaphor "the strip is a scrollbar of
desktops" -- dragging the strip right pulls the previous desktop into the indicator, the way dragging
a scrollbar right pulls earlier content into view. The test for a code path is: finger left commits
"next" (right-neighbour), finger right commits "previous" (left-neighbour).

## Two input paths, and they can both be live

Two surfaces drive the same desktop, and either or both may be running at once against one session.
**Both are Chrome**, at the panel's dev origin:

- **Chrome on the iPhone**, sending touch.
- **Chrome on the Mac**, sending a pointer over the rendered page.

The native containers -- the iPhone client app and the host's own webview -- still exist in the code
and still branch, but they are not the current path. `main.tsx` picks its transport from
`window.webkit?.messageHandlers?.agentFeed`, and on both live surfaces that is absent, so both go
through the dev server's `/api` proxy. Treat that native arm the way `FEATURE-MAP.md` says to treat
the rest of the Swift: present, compiling, not where the work is.

So the axis that matters is **not** the container. It is the pointer. A mouse has a position and
real buttons; a touch has neither, and the wire says so
(`agent-feed/wire/desktopControl.ts`): `pointer-warp` carries absolute display coordinates "for a
mouse, which has a position to honour", while touch keeps the relative `pointer-move`;
`mouse-down`/`mouse-up` exist because "a mouse has real buttons to hold; a tap has none, so touch
keeps sending `click`". Touch reaches a drag by synthesising that hold after a long press.

`TileViewport.tsx` branches on `event.pointerType === "mouse"` for absolute warping, button press and
release, and right-click. That branch, not the container, is what splits the two live surfaces.

The practical rule, and the reason this is written down: **when changing input behaviour, name which
path you mean.** A fix that only branches under `pointerType === "mouse"` does nothing on the phone,
and one written against the touch path leaves the Mac's Chrome behaving as it did before. If the
behaviour is meant to be universal it belongs above that branch, in the shared model, with the
branch used only where the two genuinely differ. This is the same trap as the surface-scoping rule
under "Code" in the root `AGENTS.md`: the previous conversation being about one path does not make the next change about it.

## The keyboard bar, and what a phone keyboard takes from the page

Settled 2026-10-19, on the owner's word. An iPhone's keyboard has no Esc, Tab or arrows, so every
focused text field on a phone gets one row of those keys standing on the keyboard
(`features/keyboard/KeyboardBar.tsx`), and the page gives up the keyboard's height and the row's
together (`app/page/keyboardInset.ts`, the one place that watches the keyboard). Three things to
know when building near it:

- **A field whose keys are its own puts them on the bar**: it marks itself
  `data-keyboard-bar="keys"` and draws its row with `OnKeyboardBar`, which the bar shows in place of
  its Esc, Tab and arrows. The terminal composer's rail does this, because its keys go to a pane
  rather than to the field. A surface that still draws its own key row in place marks its region
  `data-keyboard-bar="off"` and the bar stays away: today the terminal panes and the desktop viewer.
  A field that offers a suggestion sets `data-keyboard-suggestion` and takes it on Tab; the bar
  shows it as a key that presses Tab.
- **A bar key is a key event first.** It is dispatched to the field, so a handler written for the
  real key answers it too; only if nothing calls `preventDefault` does the bar do the key's job by
  hand (`keyboardBarKeys.ts`), because a dispatched key event moves no focus and no caret.
- **A full-screen overlay is shortened through its classes.** `fixed inset-0` is sized to the
  layout viewport, which a keyboard does not shorten, so `styles.css` ends every `.fixed.inset-0`
  at the page's bottom while the keyboard is up. An overlay built some other way stays under the
  keyboard and the bar. The bar itself is drawn as a popover, inside the open modal dialog when the
  field is in one, so neither a dialog's backdrop nor its inertness hides it.

Measured only with a stand-in keyboard in an emulated iPhone. What the real one reports, WebKit's own
form strip above the keys included, is the open question.

## Panel state: what is remembered, and where

Three places hold state in the Agent Panel, and picking the wrong one is how a reader ends up with a
panel that remembers its font size and forgets which session it was reading.

- **React state** is the default and needs no justification. Anything that should not survive a
  reload belongs here and nowhere else: dialogs, in-flight errors, hover, drag positions mid-drag.
- **The address bar** carries what a *link* should carry, and only that. Today that is the surface
  (`entry`) and the sidebar view (`view`) -- `?entry=feed&view=canvas`. **Query parameters, never
  path segments**: the panel also ships through a custom scheme whose asset resolver maps a request
  path straight onto a bundled file with no fall back to `index.html`, and the build references its
  assets relatively (`base: "./"`), so `/feed/canvas` 404s there even though the dev server answers
  it. Write it with `replaceState`, not `pushState` -- choosing a view is not a navigation, and
  making Back walk the tabs would take a reader out of the panel to leave it.
- **Storage** remembers everything deeper than a link. The reason it exists at all is that this
  panel is edited while it is being read: a Vite save that cannot update in place reloads the page
  and throws away every piece of React state, and a phone whose webview was discarded comes back
  the same way.

**The test for whether something is stored** is not "would it be nice to have back". It is:

> Persist a fact about how **this reader arranged the panel**, which would cost them real work to
> re-establish after a reload. Do not persist anything the sidecar already knows, anything derivable
> from what it sends, or anything whose absence a reader cannot see.

That last clause is the one to reread before storing something, and the example that used to sit
here is now the example of the clause being SATISFIED rather than of it biting. What is off the
canvas -- whole Bots, and single sessions -- was deliberately not stored, because a canvas that came
back whole cost one click to arrange again where one that came back missing a Bot hid it from a
reader who had forgotten taking it off. That absence is no longer unseeable: the sidebar roster
lists every Bot and every session either way, dims the ones that are off, and carries the control
that puts them back, so both sets are now remembered -- and since 2026-09-24, on the owner's word,
not in this browser: they are on each Bot's record in its machine's `bots.json` (`offCanvas`,
`offCanvasSessionRefs`, and the strip's order as `canvasPosition`, all set with
`PATCH /api/bots/:id/canvas`), so the phone, the Mac and a peer's Bots all read one answer. A fact about a Bot that every surface should agree on is the sidecar's,
even when it is an arrangement. **Cheap to redo beats quietly wrong** still
decides it -- what changed is that the panel stopped being quiet, not that the cost changed. The
rule is about whether the reader can SEE what was kept, so re-ask that question of the surface as it
is now rather than inheriting an answer. Store identity, never a record the stream owns:
`selectionStore` keeps three strings and
re-resolves them against the inventory, because a stored `SessionSummary` would be a second source
of truth that nothing refreshes.

**How to write it, today.** Add a field to the nearest existing preferences module for that feature
(`features/sidebar/sidebarPreferences.ts`, `features/bots/canvas/botCanvasPreferences.ts`,
`features/sidebar/selectionStore.ts`) rather than starting a new one. Validate every field on the
way in rather than casting -- a stale or hand-edited shape must fall back to the default, not become
a lookup for something that cannot exist -- and wrap every read and write in `try`/`catch`, because
a private window and a container with storage disabled both throw. Write from ONE place, the setter
`usePersistentState` returns (`@/hooks/state/usePersistentState`), rather than beside each of the
calls that change it; that is how one of them ends up forgotten.

**Where this is going.** There are currently three mechanisms doing this one job -- hand-rolled
`load*`/`store*` pairs, `useSyncExternalStore` singletons, and one `zustand` store -- and none of
them has a version or a migration, so every one silently discards a reader's value when its shape
changes. ADR-0114 records the decision to consolidate onto `zustand`'s `persist` middleware (already
a dependency) with `partialize`, `version` and `migrate`, and carries the migration order. Note what
`persist` does NOT change: it makes writing easy enough that the rule above stops being enforced by
friction, so it has to be enforced here. A store that writes everything it holds resurrects
transient state, and each of those comes back as a bug rather than as a convenience.

### Live data a widget shows lives in a store, not in `App`

Settled 2026-10-16, after two edits to one hook blanked the whole Feed tab three minutes apart. The
section above is about what survives a reload; this is about who owns data that only lives while
the page does -- a stream, a list read on request, an action still running.

**`App` holds only state the shell genuinely shares**: machines, inventory, selection, the canvas
roster, Bot commands, sidebar chrome. Everything else that a widget shows lives in a store the
widget subscribes to, from inside its own error boundary. The reason is the live tree: a hook
`App` calls is part of `App`. A save that breaks it, or a save that adds or removes a React hook
inside it (React's "Should have a queue", because a hook in a `.ts` file has no Fast Refresh
tracking), costs the whole tab, where the same edit in a store costs the widget at most.

The pull the other way is real and is why this kept happening: the sidebar is drawn three times
(pinned rail, hover preview, phone drawer), so a widget's state cannot live in the widget either,
or each mount opens its own stream and closing the drawer drops a restart in flight. Lifting into
`App` answered that; a store answers it without making the tab pay. Two shapes, both in the tree:

- **One machine's data**: `createSourceStore` in `activity-feed/data-source/sourceStore.ts`. One
  entry per data source in a `WeakMap`, readers counted, and whatever the entry holds open (a
  stream, a poll) closed after the last reader leaves while its state stays for the next. The work
  is plain functions beside the store; the hook only reads it with `useSourceStore` and binds them.
  `useUsage`, `useDesktopPark` and `useMessages` are built on it. `useLimits` is the same shape
  written by hand before the helper existed. A store keyed on the data source starts fresh when
  that object is rebuilt by a hot swap, which is the right answer for one machine's data.
- **Data across every machine**: `features/profile/useStaleSessions.ts`. A module-level `zustand`
  store (`createStore` from `zustand/vanilla`, read with `useStore`) keyed by `machineKey`, because
  its answer spans machines and outlives any one data source.

The widget stays presentational and takes its handles as props, so its tests stand them up
directly; a `Live*` wrapper beside it does the subscribing (`LiveProfileRow`, `MessagesInbox`), and
the sidebar passes the wrapper the data source rather than the data. A module store is the page's,
so a test file that reuses one source across tests resets it in `afterEach`
(`resetStaleSessions`); a fresh fake per test needs nothing.

Still in `App`: `usePiSessionCreation`, for the dormant Pi provider. It backs the Sessions tab's
New Pi session button and the harness's `createPiSession`, which several thread tests use to open a
live session, so it goes when Pi leaves the panel rather than moving.

## No effects outside the named hooks

`useEffect` and `useLayoutEffect` are lint errors in `src` except in `src/hooks/`, tests, and the
files `.oxlintrc.json` names, one per outside system (ADR-0146). Reach for, in order: render (and
`useStateFor` for state scoped to one value), the event handler, `usePanelQuery` for a read (key it
with `sourceKey`), `useSubscription` or a store for a stream, then the `src/hooks/` hook named for
the thing. `useDomSync` is DOM work only; `useNotify` is a parent that should be holding the state.

Nor a ref read or written while rendering. The panel builds with React Compiler (`panelReact.ts`)
and its rules are lint errors: a latest value goes through `useLatestRef`, one a handler writes
ahead of the render through `useCommitToRef`, the time through `useNow`, and a ref a hook returns
is split off the rest of what it returns. A store's hook renders from its `useSyncExternalStore`
snapshot and never from module variables beside it: the compiler takes a module variable to be
constant and caches the first answer (the Shiki highlighter stayed `null` that way), and no lint
rule says so. A check during render for "did this change" compares the inputs themselves, never a
`useMemo`'s identity: the compiler drops a memo whose result is neither returned nor drawn, and the
canvas roster's prune looped on that. A hand-written `useCallback` or `useMemo` lists every setter and
ref it uses, because the compiler skips the whole component otherwise, and so does a `finally`
clause anywhere inside it: that goes through `runWithFinally`. `panelReact.test.ts` fails on every
function the compiler would skip. One that cannot be compiled safely opts out with `"use no memo"`
and the reason beside it: today that is the feed's virtualizer and the two hooks it feeds. A lint
disable comment that silences nothing fails the gate, because one still hides its function from
the compiler and from the compiler's own lint rules.

## Attach to an element when it arrives, not to a ref

Settled 2026-10-19, on the owner's word, after a Claude card would not scroll up in its first turn.

**Anything attached to a DOM node -- a listener, an observer, a measurement -- is attached to the
node once it is there, and again if it is replaced.** Hold the node as state, with the `useState`
setter as its callback ref (or a callback that also fills a ref the imperative code reads), and
hand that element to `useEventListener`, `useResizeObserver` and the like. A ref object is read once,
when the effect behind the hook runs: a node that mounts on a later render, or is swapped for
another, is never attached, and nothing fails. The handler simply never runs.

A flag standing in for "the node is there" (`active`, `open`, `ready`) is the same slip, because
the flag and the node are set by different renders. Gate on the element itself. The case that
settled it: the transcript's tail follower (`useStickToBottom`) armed on "there is something to
follow", and a queued prompt made that true while the feed still drew "loading". The scroller
mounted a render later, the follower's wheel listener was never on it, and every scroll up read as
layout and snapped back until a reload.

A test of attach code mounts the target AFTER the hook, not with it, the order the page actually
uses (`activityFeedTailFollow.test.tsx`), and fails with the attach taken out. The callers that still
pass a ref are safe only while the node mounts in the same commit as the component holding the hook
and is never replaced. Moving one of them to an element is the fix, not a check that the ref is
filled.

## Transient states take no space

Settled 2026-10-18, on the owner's word, after the canvas jumped on every sidecar restart.

**A state that comes and goes while the content it is about stays on screen is drawn OVER that
content, never in the flow beside it.** Reconnecting, loading more, saving, retrying, a sync in
flight: each one lasts seconds and appears again on every restart, so a box in the flow pushes
everything below it down when it appears and pulls it back up when it goes, twice per occurrence.
The canvas did exactly that: "Reconnecting to Mac" was a band above the strip, and every card on
the canvas moved down and back up on each sidecar restart. On a surface that is read while it
streams, a jump moves the line the reader is on.

Three shapes, in order of preference:

- **An overlay in a positioned box**: `absolute`, `pointer-events-none`, a `z-` above the content,
  and placed OUTSIDE the scroller so it does not scroll away. `ReconnectingNotice` (a card's
  transcript), `CanvasReconnecting` (the canvas, in a `relative` wrapper around its scroller) and
  `CompactingNotice` are this shape.
- **A sticky box of no height** where there is no positioned box to float in: `sticky top-0 h-0
  overflow-visible`, with the chip hanging out of it over the first rows. `SidebarReconnecting` is
  this shape.
- **Space reserved for it at all times**, when the status has a permanent slot of its own (a
  footer line, a fixed-size button whose label turns into a spinner): the slot is drawn whether or
  not anything is in it, and the state changes what is in it, never its size.

What this does NOT cover: a placeholder that REPLACES a surface with nothing else on it
(`CanvasPlaceholder`, `SidebarStatus` for "Loading sessions…"), because there is nothing for it to
move; and a lasting condition the reader has to act on (a machine that is not answering, an error
no card can carry), which can take a band, because it is not coming and going. The test is whether
the thing appears and disappears while the content under it stays: if it does, it takes no space.

The one chip for "reconnecting" is `ReconnectingChip`; use it rather than a new look, so a reader
who has seen it once knows it everywhere.

## What an edit costs the open panel

Settled 2026-10-15. Most edits reach every open panel without reloading the page, and the ones that
still reload are a short list. A reload is the expensive outcome: every card's scroll, terminal and
loaded history goes, and the page fetches its ~490 modules again, which is seconds on the phone.

- **A save reaches the page about a second later, once the code it lands among typechecks**
  (`app/dev-server/typeHolds.ts`, since 2026-10-16). A whole `.ts`/`.tsx` file waits for a
  TypeScript 7 check of the page's code (`tsconfig.json`, not the tests'); an error the running
  page did not already have holds the waiting files it could break -- the file it is in, and any
  waiting file that file imports -- and the Profile row names the error. Everything else goes out.
  So save order inside a change stops mattering: a caller saved before its callee waits for the
  callee, and both arrive together. Under `manual` nothing goes out anyway, and the reader's Reload
  takes the tree past a type error, though never past a file that will not parse.
- **Components and hooks update in place** through React Fast Refresh. A `.tsx` file that exports
  anything besides components is not a boundary, so its update passes to every importer, which is
  harmless until the chain reaches `main.tsx`. Keep a plain helper out of a component file, the way
  `desktopDocumentHeight.ts` came out of `DesktopViewer.tsx`. A module of hooks alone, `.ts` or
  `.tsx`, is under Fast Refresh only because of `app/dev-server/hookRefresh.ts` (2026-10-18): Vite
  8.3 signs hooks only in a file whose name ends in `x` or that names the JSX runtime, and signs
  them against a no-op unless the module also has a component, so adding or removing a hook inside
  one kept every caller's old state and failed it with "Should have a queue". With the plugin the
  callers remount instead. `hookRefresh.test.ts` runs the real transform, so a Vite upgrade that
  changes either rule fails there; if "Should have a queue" comes back, run that test first.
- **The data source, its layers, the transport and the wire are swapped in place.** `main.tsx`
  accepts them, builds a fresh `FetchHttpTransport` and `SidecarDataSource`, and re-renders the
  root it already has. Every subscription and query keyed on the feed's identity (`sourceKey`, or
  `machineFeedKey` for a machine) reopens with the new code, so the reader sees what a sidecar
  restart looks like. One keyed on anything less than the feed's identity stays on the replaced
  one; `useBots` keys on each machine's feed for that reason.
- **The page-level listeners are reinstalled** (`keyboardInset.ts`, `pageLifecycle.ts`,
  `windowDrag.ts`): `main.tsx` keeps the `remove()` each returns and installs from the new module.
- **A sidecar edit restarts the sidecar and reloads nothing.** Each list and card keeps what it had
  and shows a "Reconnecting…" chip (`ReconnectingNotice.tsx`) until its stream is back, and Bot
  views wait for the catalog (`catalogReady`), so a restart no longer reads every session as
  missing.
- **Still a full reload:** `main.tsx` itself, `panelEntry.ts`, `HostActionsClient.ts` and
  `HostBridge.ts`, the telemetry modules (Sentry's `init` wraps `fetch` and closing the client does
  not unwrap it, so it is not swapped), and anything the dev server reads at startup:
  `vite.config.ts` and its plugins, `index.html`, `tsconfig.json`, `.env`, dependencies. Under a
  native container or in fixture mode a data-source edit reloads too, on purpose: both install
  their transport once.
- **A new module `main.tsx` creates or installs goes on its accept list in the same change.**
  Otherwise every edit to it reloads every open panel, and nothing reports it: the page simply
  reloads, which reads as normal.

## What the page loads before it paints

Settled 2026-10-18, from the iPhone's load telemetry: a cold load of the canvas feed spent 9.3s
before first paint fetching 2.85MB over a link moving about 285KB/s, and a large share of it was
code for screens the page was not showing and a highlighter only an expanded diff uses.

**A screen that is not the one the page opens on, and a heavy library only some rows or dialogs
use, are loaded when they are first shown, not imported by what renders the feed.** The split
points are `app/page/surfacesOnDemand.tsx` (the Desktop, Screen, IDE and Arena tabs, and the native
`desktop` and `ide` entries), `DiffBlockOnDemand` (an edit's diff and its highlighter), the park
modal in `ProfileRow` and the folder viewer in `BotCodeDialog`. Import those, never the module
behind them: one plain `import` of `DesktopViewer` or `DiffBlock` from anything the feed renders
puts the whole tree back in the main bundle, and nothing fails to say so. A production build
(`vite build`, 1.4s) shows it: the main `index-*.js` was 1.05MB gzipped before the split and 236KB
after. Split at whole screens and libraries, not at components: each split point is a round trip
and a moment of "Loading…" the first time it opens.
