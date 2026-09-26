// The panel half of the missing-reference chain: what the reader was shown, and -- the part that
// matters more -- what it was not shown again and again.
//
// Same edge trigger as the sidecar's, tested the same way, because the failure is the same and it
// is quiet either way: a level-triggered line here writes once per catalog broadcast for as long
// as a reference stays missing, which buries the one line that mattered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { BotSessionRef, BotView } from "@agentdesk/agent-feed-wire";
import { useMissingSessionLog } from "@/features/bots/useMissingSessionLog";

const BOT = {
  botId: "bot-1",
  name: "AD bot",
  environment: { kind: "directory", path: "/repo" },
  sessionRefs: [],
  metadata: { labels: [], custom: {} },
  grants: [],
  createdAt: 0,
  createdBy: { kind: "user" },
} as unknown as BotView;

const REF: BotSessionRef = { source: "claude", sessionId: "sid-1" };
const OTHER_REF: BotSessionRef = { source: "codex", sessionId: "sid-2" };

/** A Bot carrying the given missing references, and nothing else this hook looks at. */
function botWith(...missingSessionRefs: BotSessionRef[]): BotView {
  // A fresh object every call on purpose: the snapshots arrive as new objects, and a hook that only
  // works when the identity holds would pass every test below and log nothing in the panel.
  return { ...BOT, missingSessionRefs } as BotView;
}

function drawn(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => String(line.event ?? "").startsWith("agent-panel-bot-session-"));
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

describe("a Bot with nothing missing", () => {
  it("says nothing", () => {
    renderHook(() => useMissingSessionLog(botWith(), "canvas-card"));
    expect(drawn(log)).toEqual([]);
  });
});

describe("a reference being drawn as missing", () => {
  it("is announced once, with the surface that drew it", () => {
    renderHook(() => useMissingSessionLog(botWith(REF), "roster-row"));
    const [line] = drawn(log);
    expect(line.event).toBe("agent-panel-bot-session-missing");
    expect(line.surface).toBe("roster-row");
    expect(line.source).toBe("claude");
    expect(line.sessionId).toBe("sid-1");
    expect(line.botId).toBe("bot-1");
  });

  it("is not announced again when a new snapshot carries the same one", () => {
    const { rerender } = renderHook(
      ({ bot }: { bot: BotView }) => useMissingSessionLog(bot, "canvas-card"),
      { initialProps: { bot: botWith(REF) } },
    );
    expect(drawn(log)).toHaveLength(1);
    log.mockClear();
    for (let pass = 0; pass < 25; pass += 1) {
      rerender({ bot: botWith(REF) });
    }
    // The flood this exists to prevent: one line per catalog broadcast, forever, for one row.
    expect(drawn(log)).toEqual([]);
  });

  it("says again when a second reference joins it", () => {
    const { rerender } = renderHook(
      ({ bot }: { bot: BotView }) => useMissingSessionLog(bot, "canvas-card"),
      { initialProps: { bot: botWith(REF) } },
    );
    log.mockClear();
    rerender({ bot: botWith(REF, OTHER_REF) });
    const lines = drawn(log);
    expect(lines).toHaveLength(1);
    expect(lines[0].sessionId).toBe("sid-2");
  });

  it("says again when one reference leaves and another arrives in the same snapshot", () => {
    const { rerender } = renderHook(
      ({ bot }: { bot: BotView }) => useMissingSessionLog(bot, "canvas-card"),
      { initialProps: { bot: botWith(REF) } },
    );
    log.mockClear();
    rerender({ bot: botWith(OTHER_REF) });
    const lines = drawn(log);
    expect(lines.map((line) => line.event)).toEqual([
      "agent-panel-bot-session-missing",
      "agent-panel-bot-session-drawn",
    ]);
  });
});

describe("a reference that came back", () => {
  it("is announced as drawn, by session key", () => {
    const { rerender } = renderHook(
      ({ bot }: { bot: BotView }) => useMissingSessionLog(bot, "canvas-card"),
      { initialProps: { bot: botWith(REF) } },
    );
    log.mockClear();
    rerender({ bot: botWith() });
    const [line] = drawn(log);
    expect(line.event).toBe("agent-panel-bot-session-drawn");
    expect(line.session).toBe("claude:sid-1");
  });

  it("is silent on the snapshots after it", () => {
    const { rerender } = renderHook(
      ({ bot }: { bot: BotView }) => useMissingSessionLog(bot, "canvas-card"),
      { initialProps: { bot: botWith(REF) } },
    );
    rerender({ bot: botWith() });
    log.mockClear();
    for (let pass = 0; pass < 10; pass += 1) {
      rerender({ bot: botWith() });
    }
    expect(drawn(log)).toEqual([]);
  });
});
