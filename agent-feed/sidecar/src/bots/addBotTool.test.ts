import { expect, test } from "bun:test";
import type { BotRegistry } from "./botRegistry.ts";
import { createAddBotTool } from "./addBotTool.ts";

test("maps a Pi tool call onto the provider-neutral Bot registry command", async () => {
  const calls: unknown[] = [];
  const registry = {
    async add(command: unknown, actor: unknown) {
      calls.push({ command, actor });
      return {
        bot: {
          botId: "bot-1",
          name: "Reviewer",
          environment: { kind: "directory", path: "/projects/reviewer" },
          sessionRefs: [],
        },
      };
    },
  } as unknown as BotRegistry;
  const tool = createAddBotTool(registry, { source: "pi", sessionId: "chief-1" });

  const result = await tool.execute("tool-call-1", {
    name: "Reviewer",
    directory_path: "/projects/reviewer",
    icon_url: "https://example.com/reviewer.png",
    role: "Reviews release work",
    labels: ["review"],
    metadata: { team: "platform" },
  }, undefined, () => {}, undefined as never);

  expect(tool.name).toBe("add_bot");
  expect(calls).toEqual([{
    command: {
      requestId: "tool-call-1",
      name: "Reviewer",
      iconUrl: "https://example.com/reviewer.png",
      directoryPath: "/projects/reviewer",
      metadata: {
        role: "Reviews release work",
        description: undefined,
        labels: ["review"],
        custom: { team: "platform" },
      },
    },
    actor: { kind: "agent", session: { source: "pi", sessionId: "chief-1" } },
  }]);
  expect(result.details).toEqual({ botId: "bot-1" });
});
