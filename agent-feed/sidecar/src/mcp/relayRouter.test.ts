import { describe, expect, test } from "bun:test";
import {
  relayList,
  relayNotify,
  relaySend,
  relayStatus,
  type RelayDependencies,
} from "@/mcp/relayRouter";

const CLAUDE = "2adc3708-fadb-4e2f-a744-322df224faf4";
const OPENCODE = "ses_f32840781ffeRR12u72o8H3AIp";

function deps(overrides: Partial<RelayDependencies> = {}): RelayDependencies {
  return {
    hasClaudeSession: (id) => id === CLAUDE,
    hasOpencodeSession: (id) => id === OPENCODE,
    claudeSend: async () => ({ delivered: true, reason: null }),
    claudeNotify: async () => ({ delivered: true, reason: null }),
    opencodePrompt: async () => ({ delivered: true, reason: null }),
    claudeStatus: async () => ({ available: true, entrypoint: "cli", reason: null, tmuxSession: "t1" }),
    listSessions: () => [],
    ...overrides,
  };
}

describe("relay router", () => {
  test("send routes Claude to the composer path, not the inbox", async () => {
    let via = "";
    const d = deps({
      claudeSend: async () => { via = "composer"; return { delivered: true, reason: null }; },
      claudeNotify: async () => { via = "inbox"; return { delivered: true, reason: null }; },
    });
    const out = await relaySend(d, CLAUDE, "do the thing");
    expect(out.delivered).toBe(true);
    expect(via).toBe("composer");
  });

  test("notify routes Claude to the inbox path, not the composer", async () => {
    let via = "";
    const d = deps({
      claudeSend: async () => { via = "composer"; return { delivered: true, reason: null }; },
      claudeNotify: async () => { via = "inbox"; return { delivered: true, reason: null }; },
    });
    const out = await relayNotify(d, CLAUDE, "fyi only");
    expect(out.delivered).toBe(true);
    expect(via).toBe("inbox");
  });

  test("send and notify route opencode to the serve path", async () => {
    let calls = 0;
    let lastText = "";
    const d = deps({
      opencodePrompt: async (_id, text) => { calls++; lastText = text; return { delivered: true, reason: null }; },
    });
    await relaySend(d, OPENCODE, "hello");
    expect(calls).toBe(1);
    expect(lastText).toBe("hello");
    await relayNotify(d, OPENCODE, "hello");
    expect(calls).toBe(2);
    expect(lastText.startsWith("[fyi]")).toBe(true);
  });

  test("unknown sessions refuse on both paths", async () => {
    const d = deps();
    expect((await relaySend(d, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "x")).reason).toBe("unknown-session");
    expect((await relayNotify(d, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "x")).reason).toBe("unknown-session");
    expect((await relayStatus(d, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).found).toBe(false);
  });

  test("blank text and bad ids refuse before touching transports", async () => {
    let touched = false;
    const d = deps({
      claudeSend: async () => { touched = true; return { delivered: true, reason: null }; },
    });
    expect((await relaySend(d, CLAUDE, "   ")).reason).toBe("text-required");
    expect((await relaySend(d, "not-a-uuid", "x")).reason).toBe("invalid-session-id");
    expect(touched).toBe(false);
  });

  test("opencode ses_ ids pass validation", async () => {
    let prompted = "";
    const d = deps({
      opencodePrompt: async (_id, text) => { prompted = text; return { delivered: true, reason: null }; },
    });
    const out = await relaySend(d, OPENCODE, "hi");
    expect(out.delivered).toBe(true);
    expect(prompted).toBe("hi");
  });

  test("list passes through the catalog projection", () => {
    const d = deps({
      listSessions: () => [{ source: "claude", sessionId: CLAUDE, project: "/tmp", lastEventAt: 1 }],
    });
    expect(relayList(d)).toHaveLength(1);
  });
});
