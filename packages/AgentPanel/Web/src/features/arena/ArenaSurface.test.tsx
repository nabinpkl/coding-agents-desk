import { describe, expect, test } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { ArenaSurface } from "@/features/arena/ArenaSurface";
import type { AgentHttpTransport, TransportResponse } from "@/features/activity-feed/transport/AgentHttpTransport";

afterEach(cleanup);

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
  filesRead: ["/repos/one/README"],
  filesWritten: [],
  gitDiff: "diff --git a/README",
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
function harness(options: { detail?: unknown; runs?: unknown[] } = {}) {
  const posted: unknown[] = [];
  const transport: AgentHttpTransport = {
    async request(method, path, requestOptions): Promise<TransportResponse> {
      if (method === "GET" && path === "/api/arena/runs") {
        return { status: 200, body: JSON.stringify({ runs: options.runs ?? [] }) };
      }
      if (method === "GET" && path.startsWith("/api/arena/runs/")) {
        return { status: 200, body: JSON.stringify(options.detail ?? run()) };
      }
      if (method === "POST") {
        posted.push(requestOptions?.body);
        return { status: 201, body: JSON.stringify(run()) };
      }
      return { status: 404, body: "" };
    },
    subscribe: () => () => {},
  };
  return { transport, posted };
}

describe("ArenaSurface", () => {
  test("says so when there are no runs, rather than drawing an empty list", async () => {
    render(<ArenaSurface transport={harness().transport} />);
    await waitFor(() => expect(screen.getByText("No runs yet.")).toBeTruthy());
  });

  test("pushes the run list from the stream without being asked", async () => {
    const push: { send?: (payload: string) => void } = {};
    const transport: AgentHttpTransport = {
      async request() {
        return { status: 200, body: JSON.stringify({ runs: [] }) };
      },
      subscribe(_path, handlers) {
        push.send = handlers.onMessage;
        return () => {};
      },
    };
    render(<ArenaSurface transport={transport} />);
    await waitFor(() => expect(screen.getByText("No runs yet.")).toBeTruthy());

    // The stream is the whole reason the tab needs no refresh: a run closes under the reader.
    push.send?.(JSON.stringify({ type: "runs", runs: [run({ prompt: "the streamed prompt" })] }));
    await waitFor(() => expect(screen.getByText("the streamed prompt")).toBeTruthy());
  });

  test("a contestant's facts read once its run is selected", async () => {
    const { transport } = harness({ runs: [run()], detail: run() });
    render(<ArenaSurface transport={transport} />);
    await waitFor(() => expect(screen.getByText("say one word")).toBeTruthy());

    await screen.getByText("say one word").click();
    await waitFor(() => expect(screen.getByText(/1 read · 0 written/)).toBeTruthy());
    expect(screen.getByText(/2\.0s/)).toBeTruthy();
    expect(screen.getByText("ses-one")).toBeTruthy();
  });

  test("starting a run posts the prompt and the contestants asked for", async () => {
    const { transport, posted } = harness();
    render(<ArenaSurface transport={transport} />);

    const prompt = screen.getByLabelText("Prompt every contestant gets");
    const formEvent = new Event("input", { bubbles: true });
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "count to three");
    prompt.dispatchEvent(formEvent);

    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe("count to three"));
    await screen.getByText("Start run").click();

    await waitFor(() => expect(posted.length).toBe(1));
    const body = posted[0] as { prompt: string; contestants: unknown[] };
    expect(body.prompt).toBe("count to three");
    expect(body.contestants.length).toBe(2);
  });
});