// Watching a composer: what a burst of output costs, and who owns the pane while two readers hold it.

import { expect, test } from "bun:test";
import { observeTmuxComposer } from "./composerWatch.ts";
import { submitTmuxComposer, syncTmuxComposer } from "./composerDrive.ts";
import { composerPanes } from "./composerRuntime.ts";
import { TmuxUnavailable } from "../../terminal/tmuxSessions.ts";
import {
  BACKSPACE,
  CLOSE,
  END,
  held,
  KILL,
  OPEN,
  paneShowing,
  RULE,
  screenWith,
  typed,
  runtime,
  settle,
  watchable,
} from "./composerFixtures.ts";

test("reports what the composer holds without waiting for the pane to write", async () => {
  // An idle pane writes nothing at all, so a watcher that only ever spoke on output would say
  // nothing until somebody typed -- and the field would sit empty beside a box that was not.
  const { tmux, state } = watchable(["make the hover ring stronger"]);
  const seen: unknown[] = [];
  const stop = observeTmuxComposer("session", {
    onState: (reading) => { seen.push(reading); },
    onEnd: () => {},
  }, tmux);
  await settle(60);
  expect(seen).toEqual([{ text: "make the hover ring stronger", hint: null, reason: null, exact: true, commands: [] }]);
  expect(state.watching).toBe(true);
  stop();
  expect(state.watching).toBe(false);
});

test("reads once for a burst of output, not once per write", async () => {
  const { tmux, state, write } = watchable([""]);
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  await settle(60);
  const before = state.screens;
  for (let i = 0; i < 20; i += 1) write();
  await settle(300);
  // One redraw is many writes. Reading per write would read twenty times for one change, and
  // most of those captures would land mid-redraw, where the box is not on the screen at all.
  expect(state.screens - before).toBe(1);
  stop();
});

test("reports only what changed, so a redraw above the box costs nobody anything", async () => {
  const { tmux, state, write } = watchable(["hello"]);
  const seen: unknown[] = [];
  const stop = observeTmuxComposer("session", {
    onState: (reading) => { seen.push(reading); },
    onEnd: () => {},
  }, tmux);
  await settle(60);
  expect(seen).toHaveLength(1);

  // The session is working: it writes constantly, and its composer does not move.
  write();
  await settle(300);
  write();
  await settle(300);
  expect(state.screens).toBeGreaterThan(1);
  expect(seen).toHaveLength(1);

  // Now somebody types into the pane itself.
  state.rows = ["hello there"];
  write();
  await settle(300);
  expect(seen).toEqual([
    { text: "hello", hint: null, reason: null, exact: true, commands: [] },
    { text: "hello there", hint: null, reason: null, exact: true, commands: [] },
  ]);
  stop();
});

test("says a session has no pane, ends, and hangs no pipe on nothing", async () => {
  // Ends rather than waiting. There is nothing to watch, and a session gains a pane often enough
  // to matter -- the band's own terminal button resumes one -- so the retry belongs to whoever
  // asked. A stream that stayed open would need a timer to notice, which is what this replaced.
  const { tmux, state } = watchable();
  state.pane = null;
  const seen: unknown[] = [];
  let ended = 0;
  const stop = observeTmuxComposer("session", {
    onState: (reading) => { seen.push(reading); },
    onEnd: () => { ended += 1; },
  }, tmux);
  await settle(60);
  expect(seen).toEqual([{ text: null, hint: null, reason: "no-pane", exact: true, commands: [] }]);
  expect(ended).toBe(1);
  expect(state.watching).toBe(false);
  expect(state.screens).toBe(0);
  stop();
});

test("a watched pane is never ended out from under its reader", async () => {
  const { tmux, write } = watchable(["hello"]);
  let ended = 0;
  const stop = observeTmuxComposer("session", {
    onState: () => {},
    onEnd: () => { ended += 1; },
  }, tmux);
  await settle(60);
  write();
  await settle(300);
  expect(ended).toBe(0);
  stop();
});

test("stopping before the pane answers still leaves nothing watching", async () => {
  // The resolve and the watch are both awaited, so a reader that leaves in between would
  // otherwise have a pipe set on its behalf with nobody left to close it.
  const { tmux, state } = watchable();
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  stop();
  await settle(60);
  expect(state.watching).toBe(false);
});

test("a push takes the pane the watch is already on, instead of going to find it again", async () => {
  // The point of the whole registry. Resolving reads every session record on disk and asks the
  // kernel about each pid, so a debounced push per keystroke burst was paying about fifty
  // milliseconds to be told what the open watch had known since it opened.
  const { tmux, state } = watchable(["hel"]);
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  await settle(60);
  expect(state.resolved).toBe(1);

  await syncTmuxComposer("session", "hello", tmux);
  await submitTmuxComposer("session", tmux);
  expect(state.resolved).toBe(1);
  expect(state.sent).toEqual([`${END}${OPEN}lo${CLOSE}`, "\r"]);
  stop();
});

test("a push with nobody watching goes and finds the pane for itself", async () => {
  // The gap between a dropped stream and `EventSource` coming back is real, and typing during it
  // has to reach the pane. A miss resolves; it does not refuse.
  const tmux = runtime({ screen: async () => screenWith([""]) });
  await syncTmuxComposer("session", "hello", tmux);
  expect(tmux.resolved).toBe(1);
  expect(tmux.sent).toEqual([`${END}${OPEN}hello${CLOSE}`]);
});

test("a watch that let go stops lending its pane", async () => {
  const { tmux, state } = watchable([""]);
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  await settle(60);
  stop();
  await syncTmuxComposer("session", "hello", tmux);
  expect(state.resolved).toBe(2);
});

test("a pane that stops answering is dropped, so the next push says the session is gone", async () => {
  // Where a session that ended is found out, now that no push resolves by reflex. tmux takes the
  // session down with the process, so the first push after that fails truthfully and forgets the
  // pane, and the one after it resolves, finds nothing running, and says so.
  const panes = composerPanes();
  panes.hold("session", "agentdesk-1");
  const tmux = runtime({
    panes,
    pane: async () => null,
    screen: async () => { throw new TmuxUnavailable("can't find session"); },
  });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "tmux-unavailable", exact: true, commands: [] });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", exact: true, commands: [] });
});

test("two watchers hold one pane independently, and the first to leave does not take it", async () => {
  const panes = composerPanes();
  const first = panes.hold("session", "agentdesk-1");
  const second = panes.hold("session", "agentdesk-1");
  first();
  expect(panes.get("session")).toBe("agentdesk-1");
  second();
  expect(panes.get("session")).toBeNull();
});

test("a watch that started after a forget still owns its own hold", async () => {
  // The release closure holds the set it added to, which a forget detaches from the map. Deleting
  // by key alone on the way out would drop the NEXT watch's pane.
  const panes = composerPanes();
  const stale = panes.hold("session", "agentdesk-1");
  panes.forget("session");
  const fresh = panes.hold("session", "agentdesk-2");
  stale();
  expect(panes.get("session")).toBe("agentdesk-2");
  fresh();
  expect(panes.get("session")).toBeNull();
});
