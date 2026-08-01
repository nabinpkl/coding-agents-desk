import { expect, test } from "bun:test";
import { AgentUiBroker, extensionUiContext } from "./agentUiBroker.ts";

test("the first viewer response resolves a shared extension prompt", async () => {
  const broker = new AgentUiBroker(1000);
  const requests: string[] = [];
  broker.subscribe((request) => requests.push(request.requestId));
  const result = extensionUiContext(broker).select("Choose", ["one", "two"]);
  expect(requests).toHaveLength(1);
  expect(broker.respond(requests[0]!, "two")).toBe(true);
  expect(broker.respond(requests[0]!, "one")).toBe(false);
  expect(await result).toBe("two");
  broker.dispose();
});

test("dispose cancels pending extension prompts exactly once", async () => {
  const broker = new AgentUiBroker(1000);
  const pending = broker.request({ kind: "input", title: "Value" });
  broker.dispose();
  expect(await pending).toBeUndefined();
});

test("a late viewer receives every still-pending extension prompt", async () => {
  const broker = new AgentUiBroker(1000);
  const pending = broker.request({ kind: "confirm", title: "Continue?" });
  const requests: string[] = [];

  broker.subscribe((request) => requests.push(request.requestId));

  expect(requests).toHaveLength(1);
  expect(broker.respond(requests[0]!, true)).toBe(true);
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
