/**
 * The Bot roster calls: what each one asks for, answered by the fake.
 *
 * Beside `SidecarBots` for the reason that file is beside its chain: the methods moved, so
 * their tests move with them rather than staying behind in the base file.
 */

import { describe, expect, it } from "vitest";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";

describe("SidecarBots", () => {
  it("subscribes to Bot snapshots and creates a Bot with a generated request id", async () => {
    const transport = new FakeHttpTransport();
    const bot = {
      botId: "bot-1",
      name: "Captain",
      environment: { kind: "directory", path: "/projects/alpha" },
      sessionRefs: [],
      metadata: { labels: [], custom: {} },
      grants: [],
      createdAt: 1,
      createdBy: { kind: "user" },
      environmentAvailability: "available",
      sessions: [],
      missingSessionRefs: [],
    };
    transport.responses.set("POST /api/bots", { status: 201, body: JSON.stringify(bot) });
    const source = new SidecarDataSource(transport);
    const snapshots: unknown[] = [];
    source.subscribeBots((snapshot) => snapshots.push(snapshot));
    transport.deliver("/api/bots/stream", { version: 2, revision: 0, bots: [] });

    const created = await source.createBot({
      name: "Captain",
      directoryPath: "/projects/alpha",
    });

    expect(snapshots).toEqual([{ version: 2, revision: 0, bots: [] }]);
    expect(created).toEqual(bot);
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/bots",
      body: expect.objectContaining({
        requestId: expect.any(String),
        name: "Captain",
        directoryPath: "/projects/alpha",
      }),
    });
  });

  it("attaches existing sessions through the Bot-scoped route", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });
    const source = new SidecarDataSource(transport);

    await source.addBotSessions("bot-1", {
      sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/bots/bot-1/sessions",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
      },
    });
  });

  it("patches one Bot's record and deletes another by address", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("PATCH /api/bots/bot-1", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });
    transport.responses.set("DELETE /api/bots/bot-2", {
      status: 200,
      body: JSON.stringify({ deleted: "bot-2" }),
    });
    const source = new SidecarDataSource(transport);

    await source.updateBot("bot-1", { fatherSession: { source: "pi", sessionId: "pi-1" } });
    await source.deleteBot("bot-2");

    expect(transport.requests).toEqual([
      {
        method: "PATCH",
        path: "/api/bots/bot-1",
        body: { fatherSession: { source: "pi", sessionId: "pi-1" } },
      },
      { method: "DELETE", path: "/api/bots/bot-2", body: {} },
    ]);
  });

  it("surfaces a typed Bot stream error instead of treating it as an empty snapshot", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const errors: string[] = [];
    const snapshots: unknown[] = [];
    source.subscribeBots((snapshot) => snapshots.push(snapshot), (error) => errors.push(error));

    transport.deliver("/api/bots/stream", {
      error: { code: "bot-stream-failed", message: "bots.json is malformed", retryable: true },
    });

    expect(snapshots).toEqual([]);
    expect(errors).toEqual(["bots.json is malformed"]);
  });
});
