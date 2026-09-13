// The queue that keeps two senders out of one box, and what happens when a send never lands.

import { expect, test } from "bun:test";
import { syncTmuxComposer } from "./composerDrive.ts";
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
} from "./composerFixtures.ts";

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
    .toEqual({ text: "something else", hint: null, reason: null, exact: true, commands: [] });
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
  expect(fine).toEqual({ text: "two", hint: null, reason: null, exact: true, commands: [] });
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
    .toEqual({ text: "alpha", hint: null, reason: null, exact: true, commands: [] });
  expect(tmux.sent).toEqual([`${END}${OPEN}alpha${CLOSE}`]);
});

test("the turn a session is taking outlives a reload of this module", async () => {
  // `bun --watch` re-reads a changed module in process, so anything held in a module-level `const`
  // is thrown away while the requests already running keep going. Serialisation kept there would
  // stop serialising the moment somebody edits this file, which is when it is needed most.
  const store = Symbol.for("agentdesk.composerTurns");
  const held = (globalThis as Record<symbol, unknown>)[store];
  expect(held).toBeInstanceOf(Map);

  // And a fresh evaluation of the module that holds it finds the same one rather than starting its
  // own. Reached through a verb, because a queue nothing takes a turn in proves nothing.
  const reloaded = await import(`./composerDrive.ts?reloaded=${Date.now()}`);
  const tmux = runtime({ screen: async () => screenWith([""]) });
  await reloaded.syncTmuxComposer("reload-probe", "alpha", tmux);
  expect((globalThis as Record<symbol, unknown>)[store]).toBe(held);
});

