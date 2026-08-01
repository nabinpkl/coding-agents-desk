import { expect, test } from "bun:test";
import { AgentUiBroker, extensionUiContext } from "./agentUiBroker.ts";

test("the first viewer response resolves a shared extension prompt", async () => {
  const broker = new AgentUiBroker(1000);
  const requests: string[] = [];
  const events: string[] = [];
  broker.subscribe((event) => {
    events.push(event.type);
    if (event.type === "request") requests.push(event.request.requestId);
  });
  const result = extensionUiContext(broker).select("Choose", ["one", "two"]);
  expect(requests).toHaveLength(1);
  expect(broker.respond(requests[0]!, "not-visible")).toBe("invalid");
  expect(events).toEqual(["request"]);
  expect(broker.respond(requests[0]!, "two")).toBe("accepted");
  expect(events).toEqual(["request", "dismiss"]);
  expect(broker.respond(requests[0]!, "one")).toBe("already-resolved");
  expect(broker.respond("never-existed", "one")).toBe("not-found");
  expect(await result).toBe("two");
  broker.dispose();
});

test("dispose cancels pending extension prompts exactly once", async () => {
  const broker = new AgentUiBroker(1000);
  const pending = broker.request({ kind: "input", title: "Value" });
  let requestId = "";
  broker.subscribe((event) => {
    if (event.type === "request") requestId = event.request.requestId;
  });
  broker.dispose();
  expect(await pending).toBeUndefined();
  expect(broker.respond(requestId, "late")).toBe("already-resolved");
});

test("a response racing the prompt timeout is acknowledged as already resolved", async () => {
  const broker = new AgentUiBroker(0);
  let requestId = "";
  broker.subscribe((event) => {
    if (event.type === "request") requestId = event.request.requestId;
  });
  const pending = broker.request({ kind: "confirm", title: "Continue?" });
  expect(await pending).toBeUndefined();
  expect(broker.respond(requestId, true)).toBe("already-resolved");
  broker.dispose();
});

test("keyed extension status replaces and clears one shared viewer item", () => {
  const broker = new AgentUiBroker(1000);
  const events: Array<{ type: string; requestId: string; message?: string }> = [];
  const ui = extensionUiContext(broker);
  broker.subscribe((event) => {
    events.push(event.type === "request"
      ? { type: event.type, requestId: event.request.requestId, message: event.request.message }
      : { type: event.type, requestId: event.requestId });
  });

  ui.setStatus("build", "starting");
  ui.setStatus("build", "done");
  const late: string[] = [];
  broker.subscribe((event) => {
    if (event.type === "request") late.push(event.request.message ?? "");
  });
  ui.setStatus("build", undefined);

  expect(events.map((event) => event.type)).toEqual(["request", "dismiss", "request", "dismiss"]);
  expect(events.map((event) => event.message).filter(Boolean)).toEqual(["starting", "done"]);
  expect(late).toEqual(["done"]);
  broker.dispose();
});

test("a late viewer receives every still-pending extension prompt", async () => {
  const broker = new AgentUiBroker(1000);
  const pending = broker.request({ kind: "confirm", title: "Continue?" });
  const requests: string[] = [];

  broker.subscribe((event) => {
    if (event.type === "request") requests.push(event.request.requestId);
  });

  expect(requests).toHaveLength(1);
  expect(broker.respond(requests[0]!, true)).toBe("accepted");
  expect(await pending).toBe(true);
  broker.dispose();
});

test("extension output and editor state stay bounded before reaching viewers", async () => {
  const broker = new AgentUiBroker(1000);
  const requests: unknown[] = [];
  broker.subscribe((request) => requests.push(request));
  const ui = extensionUiContext(broker);

  ui.notify("é".repeat(100_000));
  ui.setEditorText("🙂".repeat(100_000));
  ui.pasteToEditor("ignored once full");

  expect(new TextEncoder().encode(JSON.stringify(requests[0])).byteLength).toBeLessThan(66 * 1024);
  expect(new TextEncoder().encode(ui.getEditorText()).byteLength).toBeLessThanOrEqual(64 * 1024);
  broker.dispose();
});
