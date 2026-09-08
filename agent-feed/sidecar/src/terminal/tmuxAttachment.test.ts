// What joining a tmux session without the PTY daemon has to get right.
//
// Two of these guard measured tmux behaviour rather than our own logic, and they are the ones worth
// keeping: a pane has exactly ONE pipe, so a second viewer must reuse the first's rather than open
// its own (which would silently close it); and nothing here may ever kill the session, because it
// belongs to whoever started it and a browser tab closing is not a reason to end their work.

import { expect, test } from "bun:test";
import { hexKeyArguments, TmuxAttachments, type TmuxPaneRuntime } from "./tmuxAttachment.ts";
import type { PtyEnvelope } from "./ptyProtocol.ts";

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

function runtime(overrides: Partial<TmuxPaneRuntime> = {}): { runtime: TmuxPaneRuntime; log: Recorded } {
  const log: Recorded = {
    pipes: 0, stops: 0, sent: [], captures: 0, resizes: [], clientChecks: 0, releases: 0,
    emit: () => {},
  };
  // The pane's real shape, so `describe` answers what `resize` did rather than a constant.
  const pane = { pid: 4242, columns: 80, rows: 24 };
  const base: TmuxPaneRuntime = {
    describe: async () => ({ ...pane }),
    capture: async () => { log.captures += 1; return "screen bytes"; },
    pipe: async (_session, onData) => {
      log.pipes += 1;
      log.emit = onData;
      return async () => { log.stops += 1; };
    },
    send: async (_session, bytes) => {
      log.sent.push(hexKeyArguments(bytes));
    },
    clients: async () => { log.clientChecks += 1; return 0; },
    resize: async (_session, columns, rows) => {
      log.resizes.push({ columns, rows });
      pane.columns = columns;
      pane.rows = rows;
    },
    releaseSize: async () => { log.releases += 1; },
  };
  return { runtime: { ...base, ...overrides }, log };
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
  expect(connection.attachment).toEqual({ sessionName: "rags", pid: 4242, columns: 80, rows: 24 });
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
  expect(seen.map((envelope) => Object.keys(envelope).filter((key) => key.startsWith("terminal"))[0]))
    .toEqual(["terminalCheckpointBegin", "terminalCheckpointChunk", "terminalCheckpointEnd"]);
  expect(seen[0]?.terminalCheckpointBegin?.revision).toBe("1");
  expect(seen[1]?.terminalCheckpointChunk?.data).toBe(btoa("screen bytes"));
  expect(seen[2]?.terminalCheckpointEnd?.revision).toBe("1");
});

/** Lets the adopt loop and everything it schedules run to completion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** The viewport report out of a stream that also carries checkpoints. */
function viewportOf(seen: PtyEnvelope[]) {
  return seen.find((envelope) => envelope.terminalViewportStatus)?.terminalViewportStatus;
}

test("the pane takes the viewer's shape when tmux says nobody else is attached", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  // Joining does not resize. The viewport report is the one place the size is decided.
  expect(connection.attachment).toMatchObject({ columns: 80, rows: 24 });
  expect(log.resizes).toEqual([]);

  const seen = collect(connection);
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toEqual([{ columns: 120, rows: 40 }]);
  expect(viewportOf(seen)).toMatchObject({
    isOwner: true,
    sourceColumns: 120,
    sourceRows: 40,
    viewColumns: 120,
    viewRows: 40,
  });
});

test("a reshaped pane is re-sent to every viewer, because nothing else redraws it", async () => {
  // `pipe-pane` carries what the PROGRAM writes, and tmux's reflow is drawn per client -- with no
  // clients there is nothing to draw, so not one byte of the new screen reaches the pipe. Measured
  // on a live pane: it went completely blank under the viewer while tmux still held the screen.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const asked = await attachments.open("rags", { columns: 200, rows: 50 });
  const bystander = await attachments.open("rags", { columns: 200, rows: 50 });
  const seenByBystander = collect(bystander);

  asked.updateViewerState({ sequence: "1", active: true, claim: false, columns: 120, rows: 40 });
  await settle();
  // The viewer that never asked for anything is looking at the same window, and has no other way
  // to hear that it changed shape.
  const begin = seenByBystander.find((envelope) => envelope.terminalCheckpointBegin);
  expect(begin?.terminalCheckpointBegin).toMatchObject({ columns: 120, rows: 40 });
  expect(log.captures).toBeGreaterThan(0);
});

test("a pane that did not move is not re-sent", async () => {
  // A checkpoint clears and rewrites the whole terminal, so sending one per viewport report would
  // flash every card on every reflow.
  const { runtime: tmux } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  const seen = collect(connection);
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 80, rows: 24 });
  await settle();
  expect(seen.some((envelope) => envelope.terminalCheckpointBegin)).toBe(false);
});

test("a pane somebody is attached to is left exactly as it is", async () => {
  // The bug this pins: a viewer opening at 80x24 used to resize the tmux window unconditionally,
  // and tmux has one window size for everyone. On a live Claude Code pane the TUI reflowed under
  // its owner and redrew its composer off the bottom of its own frame, so typed characters landed
  // in a box that was no longer where the screen said it was. A client being attached is the
  // condition that made that harmful, and it is the condition checked here.
  const { runtime: tmux, log } = runtime({ clients: async () => 1 });
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });

  const seen = collect(connection);
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toEqual([]);
  // Still reported, and reported honestly: the viewer scales its own type to the shape it finds,
  // and `isOwner: false` is what tells it the two differ for a reason.
  expect(viewportOf(seen)).toMatchObject({
    isOwner: false,
    sourceColumns: 80,
    sourceRows: 24,
    viewColumns: 120,
    viewRows: 40,
  });
});

test("a client count that cannot be read is not treated as nobody", async () => {
  // An unreadable answer and "zero clients" are the same value if a failure returns 0, and one of
  // them is the case where resizing reflows somebody's live session.
  const { runtime: tmux, log } = runtime({
    clients: async () => { throw new Error("tmux list-clients exited 1"); },
  });
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  const seen = collect(connection);
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toEqual([]);
  expect(viewportOf(seen)).toMatchObject({ isOwner: false, sourceColumns: 80 });
});

test("a burst of viewport reports costs the tmux calls for the last size, not all of them", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  for (const columns of [90, 100, 110, 120]) {
    connection.updateViewerState({ sequence: "1", active: true, claim: false, columns, rows: 40 });
  }
  await settle();
  // The first ask is in flight when the rest arrive, so it lands; the three behind it collapse to
  // the last one. A drag reporting twenty sizes must not be twenty resizes.
  expect(log.resizes).toEqual([{ columns: 90, rows: 40 }, { columns: 120, rows: 40 }]);
});

test("every resize hands the size straight back to tmux's own negotiation", async () => {
  // Measured in tmux: `resize-window -x -y` sets `window-size manual` as a side effect, and a
  // pinned window stops following a human who attaches later -- four sessions were left that way
  // the last time this repo resized panes. Released immediately rather than when the viewer
  // leaves, because a pin held for the life of a card is held across exactly the window in which
  // somebody might attach. Measured end to end: resize to 44x23, unset, attach a client at
  // 150x45, window is 150x45.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toHaveLength(1);
  expect(log.releases).toBe(1);
});

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
        await new Promise<void>((resolve) => { releaseStop = resolve; });
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
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 80, rows: 24 });
  await settle();
  connection.detach();
  await settle();
  expect(log.resizes).toEqual([]);
  expect(log.releases).toBe(0);
});

test("a failing send surfaces on the connection rather than vanishing", async () => {
  const { runtime: tmux } = runtime({
    send: async () => { throw new Error("tmux send-keys exited 1"); },
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
    pipe: async () => { throw new Error("tmux pipe-pane exited 1"); },
  });
  const attachments = new TmuxAttachments(tmux);
  await expect(attachments.open("rags", { columns: 80, rows: 24 })).rejects.toThrow("pipe-pane");
  expect(attachments.openPanes).toBe(0);
});

test("hex is two lowercase digits per byte, so tmux never sees a bare single digit", () => {
  expect(hexKeyArguments(new Uint8Array([0, 9, 15, 26, 255]))).toEqual(["00", "09", "0f", "1a", "ff"]);
});
