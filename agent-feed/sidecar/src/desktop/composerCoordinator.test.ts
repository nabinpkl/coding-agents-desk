import { describe, expect, test } from "bun:test";
import type { DesktopAuditSnapshot } from "@agentdesk/agent-feed-wire";
import { createComposerCoordinator, type ComposerEnvelope } from "@/desktop/composerCoordinator";
import { ControlHelperError, type ControlHelper } from "@/desktop/controlHelper";
import type { ProcessRow } from "@/desktop/claudeSessionResolver";

/**
 * The coordinator's window-borrowing sequence.
 *
 * These exist because the three bugs that shipped in the first cut all lived HERE and none of them
 * were reachable from the resolver tests: a move-back verified once and reported `move-failed` for a
 * window it had stranded on the active Desktop, and the lease used Claude's verbs for every session
 * regardless of source. All three are pure sequence over an injected helper, so all three are unit
 * facts rather than things only a live app can judge.
 */

const CLAUDE_PID = 4200;
const CODEX_PID = 4353;

function snapshot(windows: Partial<DesktopAuditSnapshot["windows"][number]>[] = []): DesktopAuditSnapshot {
  return {
    activeSpaceID: "3",
    diagnostic: null,
    screenRecordingTrusted: true,
    desktops: [],
    windows: windows.map((window) => ({
      windowID: 900,
      ownerPID: CLAUDE_PID,
      ownerName: "Claude",
      title: "Claude",
      layer: 0,
      spaceIDs: ["7"],
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      ...window,
    })),
  } as unknown as DesktopAuditSnapshot;
}

/** A helper whose every verb is scripted, recording the calls in order. */
function fakeHelper(
  answers: Record<string, (payload: Record<string, unknown>, nth: number) => Record<string, unknown>>,
  audit: DesktopAuditSnapshot,
) {
  const calls: { type: string; payload: Record<string, unknown> }[] = [];
  const counts = new Map<string, number>();
  const pushHandlers = new Set<(event: Record<string, unknown>) => void>();
  const helper: ControlHelper = {
    async request(type, payload = {}) {
      calls.push({ type, payload });
      const nth = (counts.get(type) ?? 0) + 1;
      counts.set(type, nth);
      if (type === "desktop-audit") return audit as unknown as Record<string, unknown>;
      const answer = answers[type];
      return answer ? answer(payload, nth) : {};
    },
    async capabilities() {
      return { inputTrusted: true, screenRecordingTrusted: true, composerVersion: 1 };
    },
    onPush(handler) {
      pushHandlers.add(handler);
      return () => pushHandlers.delete(handler);
    },
    stop() {},
  };
  return {
    helper,
    calls,
    of: (type: string) => calls.filter((call) => call.type === type),
    push: (event: Record<string, unknown>) => {
      for (const handler of pushHandlers) handler(event);
    },
  };
}

function claudeRows(sessionId: string): ProcessRow[] {
  return [
    { pid: CLAUDE_PID, parentPid: 1, arguments: "/Applications/Claude.app/Contents/MacOS/Claude" },
    { pid: 5000, parentPid: CLAUDE_PID, arguments: `claude --resume ${sessionId}` },
  ];
}

function coordinator(
  helper: ControlHelper,
  rows: ProcessRow[],
) {
  return createComposerCoordinator({
    helper,
    processRows: async () => rows,
    // Long enough that nothing under test is raced by a background pass.
    pollIntervalMs: 3_600_000,
    reviver: { noteMissing: () => [], noteFound: () => {} },
  });
}

/** Lets the coordinator's own serialized queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("borrowing a window for a write", () => {
  const session = "s-1";
  const audit = snapshot([{ windowID: 900, ownerPID: CLAUDE_PID, spaceIDs: ["7"] }]);

  test("carries the verify budget on every move, so the helper does not sample once", async () => {
    const { helper, of } = fakeHelper({
      "composer-write": () => ({ text: "hello" }),
      "frontmost-pid": () => ({ pid: 1 }),
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    await subject.sync({ source: "claude", sessionId: session }, "hello");
    const moves = of("window-move");
    expect(moves.length).toBe(2);
    for (const move of moves) {
      expect(move.payload.verifyAttempts).toBeGreaterThan(1);
      expect(move.payload.verifyIntervalMs).toBeGreaterThan(0);
    }
    subject.stop();
  });

  test("a move-back that fails once is retried rather than abandoning the window", async () => {
    const { helper, of } = fakeHelper({
      "composer-write": () => ({ text: "hello" }),
      "frontmost-pid": () => ({ pid: 1 }),
      "window-move": (payload, nth) => {
        // First move-in, then a restore that misses, then the retry.
        if (nth === 2) throw new ControlHelperError("move-failed");
        return {};
      },
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    expect(await subject.sync({ source: "claude", sessionId: session }, "hello")).toBe("hello");
    expect(of("window-move").length).toBe(3);
    subject.stop();
  });

  test("a move-back that keeps failing reports restore-failed, not move-failed", async () => {
    const { helper } = fakeHelper({
      "composer-write": () => ({ text: "hello" }),
      "frontmost-pid": () => ({ pid: 1 }),
      "window-move": (payload) => {
        if (payload.spaceID === "7") throw new ControlHelperError("move-failed");
        return {};
      },
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    await expect(subject.sync({ source: "claude", sessionId: session }, "hello"))
      .rejects.toMatchObject({ reason: "restore-failed" });
    subject.stop();
  });

  test("a move-IN that fails still reports move-failed", async () => {
    const { helper } = fakeHelper({
      "frontmost-pid": () => ({ pid: 1 }),
      "window-move": (payload) => {
        if (payload.spaceID === "3") throw new ControlHelperError("move-failed");
        return {};
      },
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    await expect(subject.sync({ source: "claude", sessionId: session }, "hello"))
      .rejects.toMatchObject({ reason: "move-failed" });
    subject.stop();
  });

  test("an absent window mover is reported as itself, since retrying cannot restore it", async () => {
    const { helper } = fakeHelper({
      "composer-write": () => ({ text: "hello" }),
      "frontmost-pid": () => ({ pid: 1 }),
      "window-move": (payload) => {
        if (payload.spaceID === "7") throw new ControlHelperError("window-mover-unavailable");
        return {};
      },
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    await expect(subject.sync({ source: "claude", sessionId: session }, "hello"))
      .rejects.toMatchObject({ reason: "window-mover-unavailable" });
    subject.stop();
  });
});

describe("the editing lease", () => {
  const session = "s-2";
  const audit = snapshot([{ windowID: 900, ownerPID: CLAUDE_PID, spaceIDs: ["7"] }]);

  test("latches and awaits Claude's composer for a Claude session", async () => {
    const { helper, of } = fakeHelper({
      "composer-read": () => ({ text: "" }),
      "question-read": () => ({ present: false }),
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    const stop = subject.watch({ source: "claude", sessionId: session }, () => {});
    await settle();
    expect(of("ax-latch").length).toBeGreaterThan(0);
    expect(of("composer-await").length).toBe(1);
    expect(of("codex-composer-await").length).toBe(0);
    stop();
    subject.stop();
  });

  test("does not latch a Codex session, and waits on Codex's own verb", async () => {
    // The bug this pins: the lease ran Claude's `ax-latch` and `composer-await` for every source.
    // Codex exposes no `AXManualAccessibility` attribute, so the borrow failed on the one app it was
    // borrowing for, and the panel blamed the move.
    const { helper, of } = fakeHelper({
      "codex-window-summaries": () => ({
        windows: [{
          windowID: 901,
          threadTitle: "",
          projectName: "",
          recentsFirstRow: "a thread",
          bounds: { x: 0, y: 0, w: 100, h: 100 },
        }],
      }),
    }, snapshot([{ windowID: 901, ownerPID: CODEX_PID, ownerName: "ChatGPT", spaceIDs: ["7"] }]));
    const subject = createComposerCoordinator({
      helper,
      processRows: async () => [
        { pid: CODEX_PID, parentPid: 1, arguments: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
      ],
      pollIntervalMs: 3_600_000,
      reviver: { noteMissing: () => [], noteFound: () => {} },
    });
    const stop = subject.watch({ source: "codex", sessionId: session }, () => {});
    await settle();
    expect(of("ax-latch").length).toBe(0);
    expect(of("composer-await").length).toBe(0);
    stop();
    subject.stop();
  });
});

describe("window-system events", () => {
  const session = "s-4";
  const audit = snapshot([{ windowID: 900, ownerPID: CLAUDE_PID, spaceIDs: ["3"] }]);

  test("an application launching re-resolves without waiting for the backstop", async () => {
    // The case a pid filter cannot narrow: at launch there is no session on that pid yet, so the
    // refresh has to cover everything. Before this the only thing that noticed was the timer, which
    // is why the interval had to be responsive and now does not.
    const { helper, of, push } = fakeHelper({
      "composer-read": () => ({ text: "" }),
      "question-read": () => ({ present: false }),
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    const stop = subject.watch({ source: "claude", sessionId: session }, () => {});
    await settle();
    // Watching turns the window-system notifications on; nothing else would deliver them.
    expect(of("workspace-observe").length).toBe(1);

    const before = of("desktop-audit").length;
    push({ type: "workspace-changed", phase: "launched", pid: 9999 });
    await settle();
    expect(of("desktop-audit").length).toBeGreaterThan(before);

    stop();
    await settle();
    expect(of("workspace-unobserve").length).toBe(1);
    subject.stop();
  });

  test("a question panel appearing refreshes only the sessions on that process", async () => {
    const { helper, of, push } = fakeHelper({
      "composer-read": () => ({ text: "" }),
      "question-read": () => ({ present: false }),
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    const stop = subject.watch({ source: "claude", sessionId: session }, () => {});
    await settle();

    const before = of("question-read").length;
    // Another instance's tree changed. This session must not pay an AX read for it.
    push({ type: "question-changed", pid: CLAUDE_PID + 1 });
    await settle();
    expect(of("question-read").length).toBe(before);

    push({ type: "question-changed", pid: CLAUDE_PID });
    await settle();
    expect(of("question-read").length).toBeGreaterThan(before);

    stop();
    subject.stop();
  });
});

describe("the observer's own refresh", () => {
  const session = "s-5";
  const audit = snapshot([{ windowID: 900, ownerPID: CLAUDE_PID, spaceIDs: ["3"] }]);

  test("re-reads the composer when the observer says it changed", async () => {
    // The skip that makes an observed pid cheap on the periodic pass was also applied to the pass
    // the observer triggered, so the notification arrived and the refresh re-emitted the value it
    // already had. Measured against a live window: an out-of-band edit sat there for twenty seconds
    // while the stream kept reporting the old text.
    let text = "first";
    const { helper, of, push } = fakeHelper({
      "composer-read": () => ({ text }),
      "question-read": () => ({ present: false }),
      "composer-observe": () => ({ observing: true }),
    }, audit);
    const subject = coordinator(helper, claudeRows(session));
    const seen: string[] = [];
    const stop = subject.watch({ source: "claude", sessionId: session }, (envelope) => {
      if (envelope.composer) seen.push(envelope.composer.composerText ?? "");
    });
    await settle();
    expect(seen).toContain("first");
    expect(of("composer-observe").length).toBe(1);

    // Somebody typed in the real window. The only thing that says so is the observer.
    text = "second";
    push({ type: "composer-changed", pid: CLAUDE_PID });
    await settle();

    expect(seen).toContain("second");
    stop();
    subject.stop();
  });
});

describe("what a watcher is told", () => {
  test("a lease that cannot be taken is reported, not silently swallowed", async () => {
    const session = "s-3";
    const { helper } = fakeHelper({
      "window-move": () => {
        throw new ControlHelperError("move-failed");
      },
    }, snapshot([{ windowID: 900, ownerPID: CLAUDE_PID, spaceIDs: ["7"] }]));
    const subject = coordinator(helper, claudeRows(session));
    const seen: ComposerEnvelope[] = [];
    const stop = subject.watch({ source: "claude", sessionId: session }, (envelope) => {
      seen.push(envelope);
    });
    await settle();
    expect(seen.some((envelope) => envelope.composer?.reason === "move-failed")).toBe(true);
    stop();
    subject.stop();
  });
});
