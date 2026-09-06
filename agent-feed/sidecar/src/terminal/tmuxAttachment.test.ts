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
  emit: (chunk: Uint8Array) => void;
}

function runtime(overrides: Partial<TmuxPaneRuntime> = {}): { runtime: TmuxPaneRuntime; log: Recorded } {
  const log: Recorded = {
    pipes: 0, stops: 0, sent: [], captures: 0, emit: () => {},
  };
  const base: TmuxPaneRuntime = {
    describe: async () => ({ pid: 4242, columns: 80, rows: 24 }),
    capture: async () => { log.captures += 1; return "screen bytes"; },
    pipe: async (_session, onData) => {
      log.pipes += 1;
      log.emit = onData;
      return () => { log.stops += 1; };
    },
    send: async (_session, bytes) => {
      log.sent.push(hexKeyArguments(bytes));
    },
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

test("the pane's size is reported, never set, even by a viewer that claims it", async () => {
  // The bug this pins: a viewer opening at 80x24 used to resize the tmux window, and tmux has one
  // window size for everyone. On a live Claude Code pane the TUI reflowed under its owner and
  // redrew its composer off the bottom of its own frame, so typed characters landed in a box that
  // was no longer where the screen said it was. The pane is authoritative; the viewer adopts it.
  const { runtime: tmux } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  expect(connection.attachment).toMatchObject({ columns: 80, rows: 24 });

  const seen = collect(connection);
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 120, rows: 40 });
  await Promise.resolve();
  expect(seen[0]?.terminalViewportStatus).toMatchObject({
    isOwner: false,
    sourceColumns: 80,
    sourceRows: 24,
    viewColumns: 120,
    viewRows: 40,
  });
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
