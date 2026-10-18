// The pane's shape as its viewers change it: who may resize it, when it is re-read and re-sent,
// and how a burst of viewport reports reaches tmux. Split from the attachment's main suite, which
// covers the pipe and the input.

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

function runtime(
  overrides: Partial<TmuxPaneRuntime> = {},
): {
  runtime: TmuxPaneRuntime;
  log: Recorded;
  pane: { pid: number; columns: number; rows: number; mouseReporting: boolean };
} {
  const log: Recorded = {
    pipes: 0, stops: 0, sent: [], captures: 0, resizes: [], clientChecks: 0, releases: 0,
    emit: () => {},
  };
  // The pane's real shape, so `describe` answers what `resize` did rather than a constant.
  const pane = { pid: 4242, columns: 80, rows: 24, mouseReporting: false };
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
  return { runtime: { ...base, ...overrides }, log, pane };
}

function collect(connection: { onEnvelope: (l: (e: PtyEnvelope) => void) => () => void }): PtyEnvelope[] {
  const seen: PtyEnvelope[] = [];
  connection.onEnvelope((envelope) => seen.push(envelope));
  return seen;
}

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
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 120, rows: 40 });
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

test("a viewer that does not claim leaves the session at the shape it already had", async () => {
  // The composer's terminal band is a glance at a session running in somebody's tmux, and a card's
  // band is a strip: claiming left two live sessions pinned at 48x9 and 56x16, small enough that
  // Claude's TUI redrew its whole frame continuously, and still that size after the band closed.
  // A tmux window has ONE size for everyone, so the only viewer allowed to set it is one big
  // enough to be somewhere you work.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  const seen = collect(connection);

  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 48, rows: 9 });
  await settle();
  expect(log.resizes).toEqual([]);

  // Still answered, and with the pane's real shape rather than the one asked for: that report is
  // what a follower scales its type against, and silence would be indistinguishable from a
  // dropped message.
  expect(viewportOf(seen)).toMatchObject({
    isOwner: false,
    sourceColumns: 80,
    sourceRows: 24,
    viewColumns: 48,
    viewRows: 9,
  });
});

test("a follower re-reads the pane's shape, and redraws when it moved", async () => {
  // Geometry used to be re-read only as a side effect of THIS side's resize, which a follower never
  // performs -- so a pane that changed shape underneath one left it rendering an absolutely
  // addressed screen into the grid the pane had when it opened.
  const { runtime: tmux, log, pane } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  const seen = collect(connection);

  // The pane moves for a reason this side had nothing to do with: somebody attached a terminal.
  pane.columns = 120;
  pane.rows = 40;
  connection.updateViewerState({ sequence: "1", active: true, claim: false, columns: 48, rows: 9 });
  await settle();

  // Still no resize -- reading is not claiming.
  expect(log.resizes).toEqual([]);
  expect(viewportOf(seen)).toMatchObject({ sourceColumns: 120, sourceRows: 40 });
  // And redrawn, because tmux draws a reflow per client and there are none: without a checkpoint
  // not one byte of the new screen would reach the pipe.
  expect(log.captures).toBeGreaterThan(0);
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

  asked.updateViewerState({ sequence: "1", active: true, claim: true, columns: 120, rows: 40 });
  await settle();
  // The viewer that never asked for anything is looking at the same window, and has no other way
  // to hear that it changed shape.
  const begin = seenByBystander.find((envelope) => envelope.terminalCheckpointBegin);
  expect(begin?.terminalCheckpointBegin).toMatchObject({ columns: 120, rows: 40 });
  expect(log.captures).toBeGreaterThan(0);
});

test("one move sends one checkpoint per viewer, however many reports queued behind it", async () => {
  // The bug this pins: the fan-out used to live in the CALLER's continuation, and every caller
  // that arrives while an applier is running is handed that applier's promise -- so a `.then` on
  // it runs once per caller, not once per move. One real resize with forty reports behind it sent
  // forty checkpoints to every viewer, each clearing and repainting a whole terminal, and each
  // making a viewer republish, which queued more callers. Measured on two viewers of one pane:
  // four pane transitions, 894 viewport reports, and 447 checkpoints EACH over half a minute.
  const { runtime: tmux } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  const seen = collect(connection);

  // The first report starts an applier; the rest arrive while it is in flight and join it. They
  // all ask for the SAME shape, so between them they are one move.
  for (let report = 0; report < 20; report += 1) {
    connection.updateViewerState({
      sequence: String(report), active: true, claim: true, columns: 120, rows: 40,
    });
  }
  await settle();
  const checkpoints = seen.filter((envelope) => envelope.terminalCheckpointBegin).length;
  expect(checkpoints).toBe(1);
});

test("a pane that did not move is not re-sent", async () => {
  // A checkpoint clears and rewrites the whole terminal, so sending one per viewport report would
  // flash every card on every reflow.
  const { runtime: tmux } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });
  const seen = collect(connection);
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 80, rows: 24 });
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
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 120, rows: 40 });
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
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toEqual([]);
  expect(viewportOf(seen)).toMatchObject({ isOwner: false, sourceColumns: 80 });
});

test("a report that asks for the size already in force does not deafen the pane to later ones", async () => {
  // The bug this pins, and it shipped: the applier was cleared by a `finally` INSIDE itself, and an
  // applier whose every iteration hits the already-there branch finishes synchronously -- so the
  // clear ran before the assignment and the assignment then latched a settled promise forever.
  // Measured on three live cards: each reached a size, took one matching report, and then ignored
  // every ask after that, sitting six or seven columns short of its box for good.
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 80, rows: 24 });

  // Exactly what the pane already is, so the applier does no work at all.
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 80, rows: 24 });
  await settle();
  expect(log.resizes).toEqual([]);

  connection.updateViewerState({ sequence: "2", active: true, claim: true, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toEqual([{ columns: 120, rows: 40 }]);
});

test("a burst of viewport reports costs the tmux calls for the last size, not all of them", async () => {
  const { runtime: tmux, log } = runtime();
  const attachments = new TmuxAttachments(tmux);
  const connection = await attachments.open("rags", { columns: 200, rows: 50 });
  for (const columns of [90, 100, 110, 120]) {
    connection.updateViewerState({ sequence: "1", active: true, claim: true, columns, rows: 40 });
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
  connection.updateViewerState({ sequence: "1", active: true, claim: true, columns: 120, rows: 40 });
  await settle();
  expect(log.resizes).toHaveLength(1);
  expect(log.releases).toBe(1);
});
