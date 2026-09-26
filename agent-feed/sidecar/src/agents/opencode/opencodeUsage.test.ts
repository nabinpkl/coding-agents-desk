// The meter is the one calculation in the opencode path that is a rule rather than a sequence,
// and three of its rules are about disagreement: the session's totals are an odometer, the
// meter wants the window, and a compaction leaves neither. Each answer below is a case where
// picking the other one draws a number that is wrong in a way a reader cannot see.
import { describe, expect, it } from "bun:test";
import { readOpencodeMeter, type OpencodeServeSession } from "@/agents/opencode/opencodeUsage";
import { OpencodeModelLimits } from "@/agents/opencode/opencodeModelLimits";
import type { SessionMessage } from "@opencode-ai/sdk/v2/client";
import type { TokenUsage } from "@/transcripts/transcriptTypes";

const limits = new OpencodeModelLimits();

function assistant(id: string, input: number, output: number, completed = 2): SessionMessage {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed },
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [{ type: "text", text: "x" }],
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionMessage;
}

function compaction(id: string): SessionMessage {
  return { id, type: "compaction", status: "completed", time: { created: 1 } } as unknown as SessionMessage;
}

function reading(
  session: OpencodeServeSession | undefined,
  history: SessionMessage[],
  previous: TokenUsage | null = null,
) {
  return readOpencodeMeter({ session, history, previous, limits, now: () => 1000 });
}

const busy: OpencodeServeSession = {
  model: { id: "m", providerID: "p" },
  tokens: { input: 330_000_000, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 1.25,
};

describe("the opencode meter", () => {
  it("reads the window off the newest turn, not the session's lifetime totals", async () => {
    // The serve publishes each turn's growing counts on that turn, so the newest one IS the
    // occupancy; summing them would count a session's whole history against one window.
    const meter = await reading(busy, [assistant("m1", 4000, 300), assistant("m2", 5000, 200)]);
    expect(meter?.usage?.current).toBe(5200);
  });

  it("names the model from the serve, and reads the cost rather than computing one", async () => {
    const meter = await reading(busy, [assistant("m1", 100, 0)]);
    expect(meter?.model).toBe("p/m");
    expect(meter?.usage?.cost).toBe(1.25);
  });

  it("names the model even when the session reports no tokens at all", async () => {
    const meter = await reading({ model: { id: "m", providerID: "p" } }, []);
    expect(meter).toEqual({ model: "p/m", usage: null });
  });

  it("answers nothing at all when the serve names neither", async () => {
    expect(await reading(undefined, [])).toBeNull();
    expect(await reading({ model: null, tokens: null }, [assistant("m1", 10, 0)])).toBeNull();
  });

  it("blanks rather than holding a pre-compaction window that no longer exists", async () => {
    const previous: TokenUsage = {
      current: 900_000,
      limit: 1_000_000,
      updatedAt: 0,
      model: "p/m",
    };
    const meter = await reading(busy, [compaction("c1")], previous);
    expect(meter?.usage).toBeNull();
  });

  it("keeps the previous reading when the batch holds no turn with tokens", async () => {
    const previous: TokenUsage = {
      current: 7_000,
      limit: null,
      updatedAt: 0,
      model: "p/m",
      cost: 0.5,
    };
    const meter = await reading(busy, [assistant("m1", 0, 0)], previous);
    expect(meter?.usage?.current).toBe(7_000);
    expect(meter?.usage?.cost).toBe(1.25);
  });

  it("seeds a session that has never reported a window from the totals", async () => {
    const meter = await reading(busy, []);
    expect(meter?.usage?.current).toBe(330_000_012);
  });

  it("treats a cost the serve cannot mean as absent rather than zero", async () => {
    const meter = await reading({ ...busy, cost: "1.25" }, [assistant("m1", 10, 0)]);
    expect(meter?.usage?.cost).toBeUndefined();
  });
});
