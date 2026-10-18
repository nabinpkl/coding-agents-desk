// What joining a tmux session without the PTY daemon has to get right.
//
// Two of these guard measured tmux behaviour rather than our own logic, and they are the ones worth
// keeping: a pane has exactly ONE pipe, so a second viewer must reuse the first's rather than open
// its own (which would silently close it); and nothing here may ever kill the session, because it
// belongs to whoever started it and a browser tab closing is not a reason to end their work.

import { expect, test } from "bun:test";
import { hexKeyArguments, TmuxAttachments, type TmuxPaneRuntime } from "@/terminal/tmux/tmuxAttachment";
import type { PtyEnvelope } from "@/terminal/pty/ptyProtocol";

interface Recorded {
  pipes: number;
  stops: number;
  sent: string[][];
  captures: number;
  /** Every size this asked tmux for, in order. Empty means the pane was never touched. */
  resizes: Array<{ columns: number; rows: number }>;
  clientChecks: number;
  releases: number;
  emit: (chunk: Uint8Array) => void;
}

function runtime(overrides: Partial<TmuxPaneRuntime> = {}): {
  runtime: TmuxPaneRuntime;
  log: Recorded;
  pane: { pid: number; columns: number; rows: number; mouseReporting: boolean };
} {
  const log: Recorded = {
    pipes: 0,
    stops: 0,
    sent: [],
    captures: 0,
    resizes: [],
    clientChecks: 0,
    releases: 0,
    emit: () => {},
  };
  // The pane's real shape, so `describe` answers what `resize` did rather than a constant.
  const pane = { pid: 4242, columns: 80, rows: 24, mouseReporting: false };
  const base: TmuxPaneRuntime = {
    describe: async () => ({ ...pane }),
    capture: async () => {
      log.captures += 1;
      return "screen bytes";
    },
    pipe: async (_session, onData) => {
      log.pipes += 1;
      log.emit = onData;
      return async () => {
        log.stops += 1;
      };
    },
    send: async (_session, bytes) => {
      log.sent.push(hexKeyArguments(bytes));
    },
    clients: async () => {
      log.clientChecks += 1;
      return 0;
    },
    resize: async (_session, columns, rows) => {
      log.resizes.push({ columns, rows });
      pane.columns = columns;
      pane.rows = rows;
    },
    releaseSize: async () => {
      log.releases += 1;
    },
  };
  return { runtime: { ...base, ...overrides }, log, pane };
}

function collect(connection: { onEnvelope: (l: (e: PtyEnvelope) => void) => () => void }): PtyEnvelope[] {
  const seen: PtyEnvelope[] = [];
  connection.onEnvelope((envelope) => seen.push(envelope));
  return seen;
}

test("reports the pane's pid and geometry, so the tile renders what is actually there", async () => {
  const { runtime: tmux } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  expect(connection.attachment).toEqual({
    sessionName: "rags",
    pid: 4242,
    columns: 80,
    rows: 24,
    mouseReporting: false,
  });
});

test("a second viewer shares the first one's pipe rather than opening another", async () => {
  // Measured in tmux: a pane holds one pipe, and setting a second does not add one. A viewer that
  // opened its own would have closed the other's, with neither able to tell.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const first = await attachments.open("rags", { columns: 80, rows: 24 });
  const second = await attachments.open("rags", { columns: 80, rows: 24 });
  expect(log.pipes).toBe(1);
  expect(attachments.openPanes).toBe(1);

  const seenByFirst = collect(first);
  const seenBySecond = collect(second);
  log.emit(new TextEncoder().encode("hi"));
  expect(seenByFirst).toHaveLength(1);
  expect(seenBySecond).toHaveLength(1);
  expect(seenByFirst[0]?.output?.data).toBe(btoa("hi"));
});

test("the pipe closes only when the last viewer leaves", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const first = await attachments.open("rags", { columns: 80, rows: 24 });
  const second = await attachments.open("rags", { columns: 80, rows: 24 });

  first.detach();
  expect(log.stops).toBe(0);
  expect(attachments.openPanes).toBe(1);

  second.detach();
  expect(log.stops).toBe(1);
  expect(attachments.openPanes).toBe(0);
});

test("a viewer that left stops receiving, and a later open starts a fresh pipe", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const first = await attachments.open("rags", { columns: 80, rows: 24 });
  const seen = collect(first);
  first.detach();
  log.emit(new TextEncoder().encode("after"));
  expect(seen).toHaveLength(0);

  await attachments.open("rags", { columns: 80, rows: 24 });
  expect(log.pipes).toBe(2);
});

test("kill does NOT end the session, whatever the caller called it", async () => {
  // The session is the owner's work. The PTY path distinguishes detach from kill because it owns a
  // process; this path owns a pipe, and there is deliberately no tmux verb here that could end a
  // session. Asserted on the runtime surface: nothing beyond stopping the pipe was asked of tmux.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  connection.kill();
  expect(log.stops).toBe(1);
  expect(log.sent).toEqual([]);
});

test("input reaches tmux as hex, control characters and escapes included", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  connection.sendInput("hi\r");
  connection.sendInput("\u001b[A");
  await Promise.resolve();
  expect(log.sent[0]).toEqual(["68", "69", "0d"]);
  expect(log.sent[1]).toEqual(["1b", "5b", "41"]);
});

test("empty input asks tmux nothing", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  connection.sendInput("");
  await Promise.resolve();
  expect(log.sent).toEqual([]);
});

test("a checkpoint is the capture, framed as begin/chunk/end with a moving revision", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  const seen = collect(connection);
  connection.requestCheckpoint("0");
  await Promise.resolve();
  await Promise.resolve();
  expect(log.captures).toBe(1);
  expect(seen.map((envelope) => Object.keys(envelope).filter((key) => key.startsWith("terminal"))[0])).toEqual([
    "terminalCheckpointBegin",
    "terminalCheckpointChunk",
    "terminalCheckpointEnd",
  ]);
  expect(seen[0]?.terminalCheckpointBegin?.revision).toBe("1");
  expect(seen[1]?.terminalCheckpointChunk?.data).toBe(btoa("screen bytes"));
  expect(seen[2]?.terminalCheckpointEnd?.revision).toBe("1");
});

/** Lets the adopt loop and everything it schedules run to completion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

test("a viewer arriving during a teardown gets a pipe, because it waits for the old one to go", async () => {
  // A pane has ONE pipe, and clearing it is a tmux command that takes a moment. Without the wait
  // the clear lands after the set, and the arriving viewer holds a pane with no pipe: measured on
  // a live pane during a burst of opening and closing, `pane_pipe` read 0 with three viewers
  // attached and 1 with none. The first is a terminal that shows the screen it imported and then
  // never moves again, which reads as a frozen session rather than as a lost pipe.
  let releaseStop: (() => void) | null = null;
  const { runtime: tmux, log } = runtime({
    pipe: async (_session, onData) => {
      log.pipes += 1;
      log.emit = onData;
      return async () => {
        log.stops += 1;
        await new Promise<void>((resolve) => {
          releaseStop = resolve;
        });
      };
    },
  });
  const attachments = new TmuxAttachments(tmux);
  const leaving = await attachments.open("rags", { columns: 80, rows: 24 });
  leaving.detach();
  expect(log.stops).toBe(1);

  const arriving = attachments.open("rags", { columns: 80, rows: 24 });
  await settle();
  // Still only the first pipe: the second is waiting on the clear rather than racing it.
  expect(log.pipes).toBe(1);

  releaseStop!();
  const connection = await arriving;
  expect(log.pipes).toBe(2);
  const seen = collect(connection);
  log.emit(new TextEncoder().encode("live"));
  expect(seen[0]?.output?.data).toBe(btoa("live"));
});

test("a window this process never resized is left entirely alone", async () => {
  // Its size option may be manual because its owner made it so, and unsetting that would be
  // reaching into a session this process only ever watched.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 80, rows: 24 });
  await settle();
  connection.detach();
  await settle();
  expect(log.resizes).toEqual([]);
  expect(log.releases).toBe(0);
});

test("a failing send surfaces on the connection rather than vanishing", async () => {
  const { runtime: tmux } = runtime({
    send: async () => {
      throw new Error("tmux send-keys exited 1");
    },
  });
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  const failures: string[] = [];
  connection.onFailure((error) => failures.push(error.message));
  connection.sendInput("x");
  await Promise.resolve();
  await Promise.resolve();
  expect(failures).toEqual(["tmux send-keys exited 1"]);
});

test("a pipe that cannot be set fails the open instead of returning a dead terminal", async () => {
  const { runtime: tmux } = runtime({
    pipe: async () => {
      throw new Error("tmux pipe-pane exited 1");
    },
  });
  const attachments = new TmuxAttachments(tmux);
  await expect(attachments.open("rags", { columns: 80, rows: 24 })).rejects.toThrow("pipe-pane");
  expect(attachments.openPanes).toBe(0);
});

test("a session recreated under its name gets a fresh pipe rather than the dead one's", async () => {
  // The panes are keyed by name, and a name outlives its process: killing a session and
  // starting a new one under it leaves the old pipe following the dead pane, so a viewer
  // joining by name shows the imported screen and then never moves again. Measured with a
  // probe session recreated this way: every later open joined the dead entry and `pane_pipe`
  // read 0. The pid tells the incarnations apart where the name cannot.
  const { runtime: tmux, log, pane } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const first = await attachments.open("rags", { columns: 80, rows: 24 });
  expect(log.pipes).toBe(1);

  pane.pid = 9999;
  const second = await attachments.open("rags", { columns: 80, rows: 24 });
  expect(log.pipes).toBe(2);
  expect(log.stops).toBe(1);
  expect(second.attachment.pid).toBe(9999);

  // The first viewer keeps its frozen connection rather than being moved: it watched a
  // process that is gone, and only a new join heals.
  const seenByFirst = collect(first);
  const seenBySecond = collect(second);
  log.emit(new TextEncoder().encode("live"));
  expect(seenByFirst).toHaveLength(0);
  expect(seenBySecond).toHaveLength(1);
});

test("hex is two lowercase digits per byte, so tmux never sees a bare single digit", () => {
  expect(hexKeyArguments(new Uint8Array([0, 9, 15, 26, 255]))).toEqual(["00", "09", "0f", "1a", "ff"]);
});
