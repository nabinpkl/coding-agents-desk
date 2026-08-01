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
