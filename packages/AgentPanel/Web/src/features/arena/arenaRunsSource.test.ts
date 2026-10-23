import { describe, expect, test } from "vitest";
import {
  createArenaRun,
  deleteArenaRun,
  fetchArenaNewRunDefaults,
  fetchArenaRunDetail,
  fetchArenaRuns,
  parseRunDetail,
  parseRunsStreamFrame,
  parseRunSummary,
} from "@/features/arena/arenaRunsSource";
import type { AgentHttpTransport, TransportResponse } from "@/features/activity-feed/transport/AgentHttpTransport";

const contestant = (over: Record<string, unknown> = {}) => ({
  contestantId: "c1",
  stance: "for",
  source: "opencode",
  sessionId: null,
  worktreePath: "/arena/11111111-1111-4111-8111-111111111111/c1",
  status: "preparing",
  startedAt: null,
  closedAt: null,
  durationMs: null,
  error: null,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  runId: "11111111-1111-4111-8111-111111111111",
  name: "arena run 1",
  folder: "/arena/arena-run-1",
  prompt: "say one word",
  round: 1,
  repoPath: "/repos/one",
  repoCreated: false,
  baseRef: "HEAD",
  mode: "headless",
  createdAt: 1,
  contestants: [contestant()],
  ...over,
});

function transportOf(handler: (method: string, path: string, body?: unknown) => TransportResponse) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const transport: AgentHttpTransport = {
    async request(method, path, options) {
      calls.push({ method, path, body: options?.body });
      return handler(method, path, options?.body);
    },
    subscribe: () => () => {},
  };
  return { transport, calls };
}

describe("parseRunsStreamFrame", () => {
  test("reads a frame of runs", () => {
    const frame = parseRunsStreamFrame(JSON.stringify({ type: "runs", runs: [run()] }));
    expect(frame?.length).toBe(1);
    expect(frame?.[0]?.prompt).toBe("say one word");
  });

  test("refuses anything it cannot read, rather than half-reading it", () => {
    expect(parseRunsStreamFrame("not json")).toBeNull();
    expect(parseRunsStreamFrame(JSON.stringify({ type: "something-else" }))).toBeNull();
    expect(parseRunsStreamFrame(JSON.stringify({ type: "runs", runs: "many" }))).toBeNull();
    // One unreadable run makes the whole frame unreadable: a list missing a row silently is
    // worse than a list that waits for the next frame.
    expect(parseRunsStreamFrame(JSON.stringify({ type: "runs", runs: [run(), { runId: 1 }] }))).toBeNull();
  });

  test("reads a Claude contestant, and refuses a harness it does not know", () => {
    const claude = parseRunsStreamFrame(
      JSON.stringify({
        type: "runs",
        runs: [run({ contestants: [contestant({ source: "claude" })] })],
      }),
    );
    expect(claude?.[0]?.contestants[0]?.source).toBe("claude");
    expect(
      parseRunsStreamFrame(
        JSON.stringify({
          type: "runs",
          runs: [run({ contestants: [contestant({ source: "pi" })] })],
        }),
      ),
    ).toBeNull();
  });

  test("refuses a run whose contestants carry a status it does not know", () => {
    expect(
      parseRunsStreamFrame(
        JSON.stringify({
          type: "runs",
          runs: [run({ contestants: [contestant({ status: "vibing" })] })],
        }),
      ),
    ).toBeNull();
  });
});

describe("parseRunSummary", () => {
  test("keeps what it reads and falls back to null for what it cannot", () => {
    expect(parseRunSummary(run())?.baseRef).toBe("HEAD");
    expect(parseRunSummary({ ...run(), createdAt: "yesterday" })).toBeNull();
    expect(parseRunSummary({ ...run(), prompt: 1 })).toBeNull();
    expect(parseRunSummary(null)).toBeNull();
  });
});

describe("parseRunDetail", () => {
  test("reads the facts a closed contestant carries", () => {
    const detail = parseRunDetail(
      run({
        contestants: [
          contestant({
            status: "closed",
            contextTokens: 1234,
            costUsd: 0.02,
            filesRead: ["/repo/README"],
            filesWritten: ["/repo/new.ts"],
            gitDiff: "diff --git a/README",
          }),
        ],
      }),
    );
    expect(detail?.contestants[0]?.filesRead).toEqual(["/repo/README"]);
    expect(detail?.contestants[0]?.gitDiff).toBe("diff --git a/README");
    expect(detail?.contestants[0]?.costUsd).toBe(0.02);
  });
});

describe("requests", () => {
  test("creates a run with one contestant entry per lineup slot, in order", async () => {
    const { transport, calls } = transportOf((method) =>
      method === "POST" ? { status: 201, body: JSON.stringify(run()) } : { status: 500, body: "" },
    );
    const answer = await createArenaRun(transport, {
      name: "",
      prompt: "say one word",
      repoPath: "/repos/one",
      mode: "terminals",
      contestants: [
        { source: "opencode", model: "", stance: "for" },
        { source: "claude", model: " sonnet ", stance: "against" },
        { source: "opencode", model: "opencode/big-pickle", stance: "for" },
      ],
      manager: null,
    });
    expect("run" in answer && answer.run.runId).toBe(run().runId);
    expect((calls[0]?.body as { contestants: unknown[] }).contestants).toEqual([
      { source: "opencode", model: null, stance: "for" },
      { source: "claude", model: "sonnet", stance: "against" },
      { source: "opencode", model: "opencode/big-pickle", stance: "for" },
    ]);
  });

  test("a refused run carries the sidecar's own message", async () => {
    const { transport } = transportOf(() => ({
      status: 400,
      body: JSON.stringify({ error: { code: "arena-bad-request", message: "a run needs a prompt" } }),
    }));
    const answer = await createArenaRun(transport, {
      name: "",
      prompt: "",
      repoPath: "/x",
      mode: "headless",
      contestants: [{ source: "opencode", model: "", stance: "for" }],
      manager: null,
    });
    expect("message" in answer && answer.message).toBe("a run needs a prompt");
  });

  test("a fetch of a run the sidecar does not have reads as nothing rather than a broken run", async () => {
    const { transport } = transportOf(() => ({ status: 404, body: "" }));
    expect(await fetchArenaRunDetail(transport, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  test("the list falls back to empty on any answer it cannot read", async () => {
    const broken = transportOf(() => ({ status: 200, body: "{not json" }));
    expect(await fetchArenaRuns(broken.transport)).toEqual([]);
    const foreign = transportOf(() => ({ status: 200, body: JSON.stringify({ runs: [{ nope: true }] }) }));
    expect(await fetchArenaRuns(foreign.transport)).toEqual([]);
  });

  test("a busy run answers its own 409 message on removal", async () => {
    const { transport } = transportOf(() => ({
      status: 409,
      body: JSON.stringify({ error: { code: "arena-run-busy", message: "still dueling" } }),
    }));
    const answer = await deleteArenaRun(transport, run().runId);
    expect("message" in answer && answer.message).toBe("still dueling");
  });
});

describe("the terminals mode", () => {
  test("a run carries its mode, and a contestant its pane and its terminal statuses", () => {
    const summary = parseRunSummary(
      run({
        mode: "terminals",
        contestants: [
          contestant({ status: "starting", tmuxSession: "arena-c1-11111111" }),
          contestant({ contestantId: "c2", status: "ready", tmuxSession: "arena-c2-11111111" }),
        ],
      }),
    );
    expect(summary?.mode).toBe("terminals");
    expect(summary?.contestants.map((c) => [c.status, c.tmuxSession])).toEqual([
      ["starting", "arena-c1-11111111"],
      ["ready", "arena-c2-11111111"],
    ]);
  });

  test("a run with no mode, name, folder or repository flag is not a run this panel reads", () => {
    expect(parseRunSummary(run())?.contestants[0]?.tmuxSession).toBeNull();
    for (const missing of ["mode", "name", "folder", "repoCreated"]) {
      const { [missing]: _dropped, ...rest } = run() as Record<string, unknown>;
      expect(parseRunSummary(rest)).toBeNull();
    }
  });

  test("the mode the reader chose and the name they gave ride the create request", async () => {
    const { transport, calls } = transportOf(() => ({ status: 201, body: JSON.stringify(run()) }));
    await createArenaRun(transport, {
      name: "duel",
      prompt: "p",
      repoPath: "",
      mode: "terminals",
      contestants: [{ source: "claude", model: "", stance: "for" }],
      manager: "claude",
    });
    expect(calls[0]?.body).toMatchObject({ name: "duel", repoPath: "", mode: "terminals", manager: "claude" });
  });

  test("a run's manager is read whole; none is null, and one this panel cannot read makes the run unreadable", () => {
    expect(parseRunSummary(run())?.manager).toBeNull();
    const manager = {
      source: "claude",
      status: "open",
      folder: "/arena/run/manager",
      sessionId: "s-manager",
      tmuxSession: "pane-manager",
      error: null,
    };
    expect(parseRunSummary({ ...run(), manager })?.manager).toEqual(manager);
    expect(parseRunSummary({ ...run(), manager: { ...manager, status: "deliberating" } })).toBeNull();
  });

  test("a blank run's defaults are read whole, and an answer missing any part is none", async () => {
    const whole = { modes: ["terminals", "headless"], arenaHome: "/Users/me/.arena", nextName: "arena run 3" };
    const offered = transportOf(() => ({ status: 200, body: JSON.stringify(whole) }));
    expect(await fetchArenaNewRunDefaults(offered.transport)).toEqual(whole);
    expect(offered.calls[0]?.path).toBe("/api/arena/new-run");
    const silent = transportOf(() => ({ status: 404, body: "" }));
    expect(await fetchArenaNewRunDefaults(silent.transport)).toBeNull();
    const garbled = transportOf(() => ({ status: 200, body: JSON.stringify({ ...whole, modes: ["telepathy"] }) }));
    expect(await fetchArenaNewRunDefaults(garbled.transport)).toBeNull();
    const nameless = transportOf(() => ({ status: 200, body: JSON.stringify({ ...whole, nextName: 3 }) }));
    expect(await fetchArenaNewRunDefaults(nameless.transport)).toBeNull();
  });
});
