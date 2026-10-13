import { describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { ArenaSurface } from "@/features/arena/ArenaSurface";
import type { AgentHttpTransport, TransportResponse } from "@/features/activity-feed/transport/AgentHttpTransport";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";

afterEach(cleanup);

// The diff viewer measures text on a canvas, which jsdom does not have; the same stub the app's
// own tests use. What is pinned here is which lane a diff lands in, not how the viewer draws it.
vi.mock("@git-diff-view/react", () => ({
  DiffView: () => <div data-testid="diff-view" />,
  DiffModeEnum: { Unified: 1 },
}));
vi.mock("@git-diff-view/file", () => ({
  DiffFile: {
    createInstance: () => ({ initTheme() {}, init() {}, buildUnifiedDiffLines() {} }),
  },
}));

const contestant = (over: Record<string, unknown> = {}) => ({
  contestantId: "c1",
  source: "opencode",
  sessionId: "ses-one",
  worktreePath: "/arena/11111111-1111-4111-8111-111111111111/c1",
  status: "closed",
  startedAt: 1,
  closedAt: 3,
  durationMs: 2000,
  error: null,
  contextTokens: 1234,
  costUsd: 0.02,
  filesRead: ["/arena/11111111-1111-4111-8111-111111111111/c1/README.md"],
  filesWritten: [],
  gitDiff: null,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  runId: "11111111-1111-4111-8111-111111111111",
  prompt: "say one word",
  repoPath: "/repos/one",
  baseRef: "HEAD",
  createdAt: 1,
  contestants: [contestant()],
  ...over,
});

/** A transport that answers the arena's own routes and records what was asked of it. */
function harness(options: { detail?: unknown; runs?: unknown[]; modes?: string[] } = {}) {
  const posted: unknown[] = [];
  const postedTo: string[] = [];
  const transport: AgentHttpTransport = {
    async request(method, path, requestOptions): Promise<TransportResponse> {
      if (method === "GET" && path === "/api/arena/modes" && options.modes) {
        return { status: 200, body: JSON.stringify({ modes: options.modes }) };
      }
      if (method === "GET" && path === "/api/arena/runs") {
        return { status: 200, body: JSON.stringify({ runs: options.runs ?? [] }) };
      }
      if (method === "GET" && path.startsWith("/api/arena/runs/")) {
        return { status: 200, body: JSON.stringify(options.detail ?? run()) };
      }
      if (method === "POST" && path.endsWith("/prompt")) {
        posted.push(requestOptions?.body);
        postedTo.push(path);
        const prompt = (requestOptions?.body as { prompt: string }).prompt;
        return { status: 200, body: JSON.stringify({ ...((options.runs?.[0] as object) ?? run()), prompt }) };
      }
      if (method === "POST") {
        posted.push(requestOptions?.body);
        postedTo.push(path);
        return { status: 201, body: JSON.stringify(run()) };
      }
      return { status: 404, body: "" };
    },
    subscribe: () => () => {},
  };
  return { transport, posted, postedTo };
}

/**
 * The surface as the tab mounts it. The catalog stream answers nothing here, so a lane shows its
 * not-listed state rather than mounting a whole `SessionView` in jsdom; the lanes themselves are
 * verified in a real browser by `chrome-test/arena-verify.mjs`.
 */
function mount(transport: AgentHttpTransport) {
  const host = {} as HostActionsClient;
  return render(<ArenaSurface transport={transport} feed={new SidecarDataSource(transport)} host={host} />);
}

const DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1 +1 @@",
  "-export const widget = 1;",
  "+export const widget = 2;",
].join("\n");

const duel = () =>
  run({
    contestants: [
      contestant(),
      contestant({
        contestantId: "c2",
        source: "claude",
        sessionId: "claude-two",
        worktreePath: "/arena/11111111-1111-4111-8111-111111111111/c2",
        durationMs: 8000,
        filesRead: ["/arena/11111111-1111-4111-8111-111111111111/c2/README.md"],
        filesWritten: ["/arena/11111111-1111-4111-8111-111111111111/c2/src/widget.ts"],
        gitDiff: DIFF,
      }),
    ],
  });

async function openRun(prompt: string) {
  const row = await screen.findByRole("button", { name: new RegExp(prompt) });
  row.click();
  await screen.findByRole("region", { name: "c1 OpenCode facts" });
}

describe("ArenaSurface", () => {
  test("opens on the composer, with the rail saying there are no runs", async () => {
    mount(harness().transport);
    await screen.findByText("No runs on this machine yet.");
    expect(screen.getByLabelText("Prompt every contestant gets")).toBeTruthy();
    expect(screen.getByText("Bake-off · 1 OpenCode vs 1 Claude")).toBeTruthy();
  });

  test("pushes the run list from the stream without being asked", async () => {
    const push: { send?: (payload: string) => void } = {};
    const transport: AgentHttpTransport = {
      async request() {
        return { status: 200, body: JSON.stringify({ runs: [] }) };
      },
      subscribe(path, handlers) {
        if (path === "/api/arena/runs/stream") push.send = handlers.onMessage;
        return () => {};
      },
    };
    mount(transport);
    await screen.findByText("No runs on this machine yet.");
    // The stream is the whole reason the tab needs no refresh: a run closes under the reader.
    push.send?.(JSON.stringify({ type: "runs", runs: [run({ prompt: "the streamed prompt" })] }));
    await screen.findByText("the streamed prompt");
  });

  test("each lane carries the same fact rows, in the same order, over its own contestant", async () => {
    mount(harness({ runs: [duel()], detail: duel() }).transport);
    await openRun("say one word");
    const facts = (name: string) => {
      const lane = screen.getByRole("region", { name: `${name} facts` });
      return [...lane.querySelectorAll("dl > div")].map((row) => row.textContent ?? "");
    };
    const c1 = facts("c1 OpenCode");
    const c2 = facts("c2 Claude");
    // Same labels in the same order is what lets the rows read across lanes.
    const labels = (name: string) =>
      [...screen.getByRole("region", { name: `${name} facts` }).querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels("c1 OpenCode")).toEqual(labels("c2 Claude"));
    expect(c1).toEqual(["Time2.0s", "Files read1", "Files written0", "Diffno change", "Context1.2k tokens", "Cost$0.0200"]);
    expect(c2).toEqual(["Time8.0s", "Files read1", "Files written1", "Diff+1−1in 1 file", "Context1.2k tokens", "Cost$0.0200"]);
  });

  test("a running lane shows what is not known yet as a dash, never as zero", async () => {
    const running = run({
      contestants: [contestant({ status: "running", closedAt: null, durationMs: null, contextTokens: null, costUsd: null })],
    });
    mount(harness({ runs: [running], detail: running }).transport);
    await openRun("say one word");
    const lane = screen.getByRole("region", { name: "c1 OpenCode facts" });
    const rows = [...lane.querySelectorAll("dl > div")].map((row) => row.textContent ?? "");
    expect(rows.slice(1)).toEqual(["Files read—", "Files written—", "Diff—", "Context—"]);
    expect(rows[0]).toMatch(/so far$/);
  });

  test("the files view puts a file both lanes read on one row, by its repository path", async () => {
    mount(harness({ runs: [duel()], detail: duel() }).transport);
    await openRun("say one word");
    screen.getByRole("tab", { name: /Files/ }).click();
    const readme = await screen.findByRole("rowheader", { name: "README.md" });
    expect(readme.closest("tr")?.textContent).toBe("README.mdreadread");
    const widget = screen.getByRole("rowheader", { name: "src/widget.ts" });
    expect(widget.closest("tr")?.textContent).toBe("src/widget.ts·wrote");
  });

  test("the diffs view gives each lane its own column, saying so when it changed nothing", async () => {
    mount(harness({ runs: [duel()], detail: duel() }).transport);
    await openRun("say one word");
    screen.getByRole("tab", { name: /Diffs/ }).click();
    await screen.findByText("Changed nothing in its worktree.");
    const c2 = screen.getByRole("region", { name: "c2 diff" });
    expect(c2.textContent).toContain("src/widget.ts");
    expect(c2.querySelector("[data-testid=diff-view]")).not.toBeNull();
  });

  test("a lane whose session the catalog has not listed says so, by id", async () => {
    mount(harness({ runs: [duel()], detail: duel() }).transport);
    await openRun("say one word");
    const lane = await screen.findByRole("region", { name: "c2 Claude session" });
    expect(lane.textContent).toContain("not in the catalog yet");
    expect(lane.textContent).toContain("claude-two");
  });

  test("starting a run posts the prompt and the lineup in lane order, then opens the run", async () => {
    const { transport, posted } = harness();
    mount(transport);
    const prompt = screen.getByLabelText("Prompt every contestant gets");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "count to three");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe("count to three"));
    screen.getByRole("button", { name: /Start run/ }).click();

    await waitFor(() => expect(posted.length).toBe(1));
    const body = posted[0] as { prompt: string; contestants: unknown[] };
    expect(body.prompt).toBe("count to three");
    expect(body.contestants).toEqual([{ source: "opencode" }, { source: "claude" }]);
    await screen.findByRole("tablist", { name: "Compare by" });
  });

  test("the lineup grows, changes harness and shrinks one lane at a time", async () => {
    mount(harness().transport);
    screen.getByLabelText("Add a contestant").click();
    const third = await screen.findByRole("radiogroup", { name: "Contestant 3 harness" });
    expect(third.querySelector("[aria-checked=true]")?.textContent).toBe("Claude");
    (third.querySelector("[role=radio]") as HTMLButtonElement).click();
    await waitFor(() => expect(screen.getByText("Bake-off · 2 OpenCode vs 1 Claude")).toBeTruthy());

    screen.getByLabelText("Add a contestant").click();
    await screen.findByRole("radiogroup", { name: "Contestant 4 harness" });
    expect(screen.queryByLabelText("Add a contestant")).toBeNull();

    screen.getByLabelText("Remove contestant 1").click();
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Contestant 4 harness" })).toBeNull());
  });

  test("in the Terminals mode an empty prompt opens the lanes rather than refusing to start", async () => {
    const { transport, posted } = harness({ modes: ["terminals", "headless"] });
    mount(transport);
    const open = await screen.findByRole("button", { name: /Open lanes/ });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    open.click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ prompt: "", mode: "terminals" });
  });

  test("a run whose lanes wait for their prompt takes it in its header and sends it to every lane", async () => {
    const waiting = run({
      mode: "terminals",
      prompt: "",
      contestants: [contestant({ status: "ready" }), contestant({ contestantId: "c2", source: "claude", status: "starting" })],
    });
    const { transport, posted, postedTo } = harness({ modes: ["terminals", "headless"], runs: [waiting], detail: waiting });
    mount(transport);
    await openRun("Waiting for a prompt");
    expect(screen.getByText("1 of 2 ready")).toBeTruthy();
    const box = screen.getByLabelText("Prompt every lane gets");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "count to three");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("count to three"));
    screen.getByRole("button", { name: /Send to every lane/ }).click();

    await waitFor(() => expect(postedTo).toEqual(["/api/arena/runs/11111111-1111-4111-8111-111111111111/prompt"]));
    expect(posted[0]).toEqual({ prompt: "count to three" });
  });
});
