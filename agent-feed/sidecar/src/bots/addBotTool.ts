import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { BotRegistry } from "./botRegistry.ts";

/** Pi adapter over the provider-neutral BotRegistry command. */
export function createAddBotTool(registry: BotRegistry, caller: BotSessionRef) {
  return defineTool({
    name: "add_bot",
    label: "Add Bot",
    description: "Add a named Bot to AgentDesk around one existing AgentDesk project directory. Sessions are attached to the Bot separately.",
    promptSnippet: "Add a curated AgentDesk Bot around an explicitly named existing project directory",
    promptGuidelines: [
      "Use add_bot only when the user has identified the exact existing project directory.",
      "Do not select or create a provider session while adding the Bot.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 64, description: "User-facing Bot name" }),
      directory_path: Type.String({ minLength: 1, maxLength: 4096, description: "Exact existing AgentDesk project directory" }),
      icon_url: Type.Optional(Type.String({ maxLength: 2048, description: "Optional https Bot icon URL" })),
      role: Type.Optional(Type.String({ maxLength: 120 })),
      description: Type.Optional(Type.String({ maxLength: 1000 })),
      labels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 12 })),
      metadata: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ minLength: 1, maxLength: 256 }))),
    }),
    execute: async (toolCallId, params, signal) => {
      if (signal?.aborted) throw new DOMException("add_bot aborted", "AbortError");
      const added = await registry.add({
        requestId: toolCallId,
        name: params.name,
        iconUrl: params.icon_url,
        directoryPath: params.directory_path,
        metadata: {
          role: params.role,
          description: params.description,
          labels: params.labels,
          custom: params.metadata,
        },
      }, { kind: "agent", session: caller });
      const bot = added.bot;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            botId: bot.botId,
            name: bot.name,
            environment: bot.environment,
            sessionRefs: bot.sessionRefs,
          }),
        }],
        details: { botId: bot.botId },
      };
    },
  });
}
