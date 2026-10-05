// Watching a pane for what its composer holds, and what one watcher owes another.
//
// A pane has one pipe, so the hold is shared and the last watcher to leave releases it.
// The turn tests at the end are about the other exclusive thing: one push at a time per
// session, because two would read the same box and both paste their whole text into it.

import { expect, test } from "bun:test";
import {
  ABOVE_PROMPT,
  BACKSPACE,
  BOX_COLUMN,
  CLOSE,
  clearPressesFor,
  END,
  held,
  KILL,
  OPEN,
  paneShowing,
  RULE,
  runtime,
  screenWith,
  settle,
  typed,
  watchable,
} from "@/input/tmuxComposerHarness";
import {
  composerPanes,
  observeTmuxComposer,
  submitTmuxComposer,
  syncTmuxComposer,
  type TmuxComposerWatchRuntime,
} from "@/input/tmuxComposer";
import { TmuxUnavailable, type TmuxPaneView } from "@/terminal/tmux/tmuxSessions";

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
  // One reading of the pane carries both halves now: the box, and whatever dialog stands in
  // front of it. There is no dialog here, which is a statement rather than an absence.
  expect(seen).toEqual([{
    composer: { text: "make the hover ring stronger", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] },
    question: null,
  }]);
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
    { composer: { text: "hello", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] }, question: null },
    {
      composer: { text: "hello there", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] },
      question: null,
    },
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
  expect(seen).toEqual([{
    composer: { text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] },
    question: null,
  }]);
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
    .toEqual({ text: null, hint: null, reason: "tmux-unavailable", exact: true, commands: [], pastes: [], images: [] });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] });
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

test("two pushes at one session do not read the same box and both paste their whole text", async () => {
  // The reader's bug, in the shape it actually happened. The panel debounces at 90ms and a push
  // over a slow link takes longer than that, so a second push starts while the first is still out.
  // Measured against a live pane before this was serialised: "hello wor" and "hello world now"
  // fired together left the box holding `hello world nowhello wor`, and both requests answered
  // 200. Here the pane is slow in the same two places a real one is.
  let held = "";
  const tmux = runtime({
    screen: async () => {
      await new Promise((wake) => setTimeout(wake, 5));
      return screenWith([held]);
    },
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      await new Promise((wake) => setTimeout(wake, 5));
      held += typed(keys);
    },
  });

  await Promise.all([
    syncTmuxComposer("session", "hello wor", tmux),
    syncTmuxComposer("session", "hello world now", tmux),
  ]);

  // Whichever ran second appended only what it was missing, because it read a box the first had
  // already finished writing to.
  expect(held).toBe("hello world now");
  expect(tmux.sent).toEqual([`${END}${OPEN}hello wor${CLOSE}`, `${END}${OPEN}ld now${CLOSE}`]);
});

test("a push waits for its send to reach the screen, so the next one reads the box and not its past", async () => {
  // Claude redraws 21-46ms after `send-keys` returns (measured, ten trials). A push that returned
  // inside that window would hand the next one a screen showing the moment before its own send.
  let held = "";
  let reads = 0;
  const tmux = runtime({
    screen: async () => {
      reads += 1;
      return screenWith([held]);
    },
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      // Late, the way a pane is: the send returns before the screen carries it.
      setTimeout(() => { held += typed(keys); }, 20);
    },
  });

  await syncTmuxComposer("session", "alpha", tmux);
  // It did not return on the strength of the send alone: the screen now carries it.
  expect(held).toBe("alpha");
  expect(reads).toBeGreaterThan(1);
});

test("a send that never shows up on screen gives the push back rather than holding it forever", async () => {
  // The pane belongs to whoever is sitting at it, and they may have typed something that makes the
  // reading never match. Waiting is worth a moment and is not worth a request.
  const tmux = runtime({ screen: async () => screenWith(["frozen"]) });
  const started = Date.now();
  expect(await syncTmuxComposer("session", "something else", tmux))
    .toEqual({ text: "something else", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] });
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a failed turn does not take the next one down with it", async () => {
  // The chain the next caller waits on must never carry a rejection, or one unreachable pane would
  // fail every push queued behind it on that session.
  let first = true;
  const tmux = runtime({
    screen: async () => {
      if (first) {
        first = false;
        throw new TmuxUnavailable("no server running");
      }
      return screenWith([""]);
    },
  });
  const [broken, fine] = await Promise.all([
    syncTmuxComposer("shared", "one", tmux),
    syncTmuxComposer("shared", "two", tmux),
  ]);
  expect(broken.reason).toBe("tmux-unavailable");
  expect(fine).toEqual({ text: "two", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] });
});

test("a push that landed is not reported as failed because the pane stopped answering afterwards", async () => {
  // The wait happens after the send, so tmux going away during it says nothing about whether the
  // text arrived. Reporting that as an unavailable session would also drop the held pane, making
  // the next push pay a full resolution for a push that had already worked.
  let sends = 0;
  const tmux = runtime({
    screen: async () => {
      if (sends > 0) throw new TmuxUnavailable("no server running");
      return screenWith([""]);
    },
    send: async (_pane, bytes) => {
      sends += 1;
      tmux.sent.push(new TextDecoder().decode(bytes));
    },
  });
  expect(await syncTmuxComposer("session", "alpha", tmux))
    .toEqual({ text: "alpha", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] });
  expect(tmux.sent).toEqual([`${END}${OPEN}alpha${CLOSE}`]);
});

test("the turn a session is taking outlives a reload of this module", async () => {
  // `bun --watch` re-reads a changed module in process, so anything held in a module-level `const`
  // is thrown away while the requests already running keep going. Serialisation kept there would
  // stop serialising the moment somebody edits this file, which is when it is needed most.
  const store = Symbol.for("agentdesk.composerTurns");
  const held = (globalThis as Record<symbol, unknown>)[store];
  expect(held).toBeInstanceOf(Map);

  // And a fresh evaluation of this module finds the same one rather than starting its own.
  const reloaded = await import(`./tmuxComposer.ts?reloaded=${Date.now()}`);
  const tmux = runtime({ screen: async () => screenWith([""]) });
  await reloaded.syncTmuxComposer("reload-probe", "alpha", tmux);
  expect((globalThis as Record<symbol, unknown>)[store]).toBe(held);
});
