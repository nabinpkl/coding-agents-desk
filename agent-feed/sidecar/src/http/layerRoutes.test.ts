import { afterEach, describe, expect, test } from "bun:test";
import { handleProjectRoutes } from "./projectRoutes.ts";
import { handleSessionRoutes } from "./sessionRoutes.ts";
import { state } from "../transcripts/transcriptState.ts";

const server = undefined as never;
const sessionId = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  state.sessions.clear();
  state.watcherState = "idle";
});

describe("layered inventory routes", () => {
  test("returns inventory-not-ready while initial reconciliation is running", () => {
    state.watcherState = "reconciling";
    const request = new Request("http://localhost/api/projects");
    const response = handleProjectRoutes(request, new URL(request.url), server);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
  });

  test("rejects malformed event pagination before opening an index", async () => {
    state.watcherState = "live";
    const request = new Request(
      `http://localhost/api/sessions/codex/${sessionId}/events?offset=invalid`,
    );
    const response = await handleSessionRoutes(
      request,
      new URL(request.url),
      server,
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(state.eventByteOffsets.size).toBe(0);
  });

  test("does not retain the removed digest route", () => {
    state.watcherState = "live";
    const request = new Request("http://localhost/api/projects/digest");
    expect(handleProjectRoutes(request, new URL(request.url), server)).toBeUndefined();
  });
});
