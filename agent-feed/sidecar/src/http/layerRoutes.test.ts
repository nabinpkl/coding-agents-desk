import { afterEach, describe, expect, test } from "bun:test";
import { createInventoryRoutes } from "@/http/inventoryRoutes";
import { handleSessionRoutes } from "@/http/session-routes/sessionRoutes";
import { state } from "@/transcripts/transcriptState";

const server = undefined as never;
const sessionId = "11111111-1111-1111-1111-111111111111";
const handleInventoryRoutes = createInventoryRoutes();

afterEach(() => {
  state.sessions.clear();
  state.watcherState = "idle";
});

describe("layered inventory routes", () => {
  test("returns inventory-not-ready while initial reconciliation is running", async () => {
    state.watcherState = "reconciling";
    const request = new Request("http://localhost/api/inventory/stream");
    const response = await handleInventoryRoutes(request, new URL(request.url), server);

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

  test("does not retain the routes the one inventory stream replaced", async () => {
    state.watcherState = "live";
    // The project list and the per-project session lists rode a connection each; both
    // are now messages on `/api/inventory/stream`, and neither answers on its own path.
    for (const path of ["/api/projects", "/api/projects/digest", "/api/projects/stream"]) {
      const request = new Request(`http://localhost${path}`);
      expect(await handleInventoryRoutes(request, new URL(request.url), server)).toBeUndefined();
      expect(await handleSessionRoutes(request, new URL(request.url), server)).toBeUndefined();
    }
    // The per-session event stream went the same way, into the timeline endpoint.
    for (const path of ["/api/sessions/stream", `/api/sessions/codex/${sessionId}/stream`]) {
      const request = new Request(`http://localhost${path}`);
      const response = await handleSessionRoutes(request, new URL(request.url), server);
      expect((response as Response).status).toBe(400);
    }
  });
});
