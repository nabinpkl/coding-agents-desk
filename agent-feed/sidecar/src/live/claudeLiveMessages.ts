// One assistant message, assembled from the Anthropic stream events that build it.
//
// The observer hands over `/v1/messages` SSE frames one at a time; this is what each
// frame does to the message under construction, what the message's usage record says
// about the session, and how a finished or half-finished message is published to the
// projection a reader is subscribed to.

import { contextWindowFor } from "@/config";
import { cacheTtlFromUsage } from "@/cacheTtl";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import type { ActivityBlock, EventCacheHit, TokenUsage } from "@/transcripts/transcriptTypes";
import type { AnthropicStreamEvent } from "@/live/claudeNetworkSource";
import type { ToolResultItem } from "@/live/claudeRequestBody";
import { summarizeToolUse } from "@/transcripts/claude/claudePayloads";

const TOOL_RESULT_PREVIEW_CAP = 16_000;

export interface LiveMessage {
  id: string;
  /** Raw Anthropic message id (`msg_...`) shared with the durable transcript. */
  messageId?: string;
  ts: number;
  phase: "streaming" | "complete";
  blocks: ActivityBlock[];
  toolRaw: Map<number, string>;
  /** Per-turn prompt-cache summary, from the message's usage record. */
  cacheHit?: EventCacheHit;
}

export function usageFor(model: string | undefined, usage: unknown, ts: number): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const current = input + cacheCreate + cacheRead + output;
  if (current <= 0) return null;
  // Read here as well as in the durable adapter, not folded into it: the panel picks
  // whichever of the two snapshots is newer rather than merging them, so a live report
  // that named no lifetime would blank the countdown for exactly as long as a session
  // is streaming, which is when it is most watched.
  const cacheTtlMs = cacheTtlFromUsage(u);
  return {
    current,
    limit: contextWindowFor(model),
    updatedAt: ts || Date.now(),
    ...(model ? { model } : {}),
    ...(cacheTtlMs ? { cacheTtlMs } : {}),
  };
}

// Per-turn prompt-cache summary for the cache-hit badge, matching the durable
// transcript adapter's semantics: cached = `cache_read_input_tokens`, input =
// the whole prompt including what this turn wrote to the cache.
export function extractClaudeCacheHit(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const total = input + cacheCreate + cacheRead;
  if (total <= 0) return undefined;
  return { cached: cacheRead, input: total };
}

/** The tool results a request body carried, as the blocks a user event is made of. */
export function toolResultBlocks(results: ToolResultItem[]): ActivityBlock[] {
  return results.map((result) => {
    const preview = result.text.slice(0, TOOL_RESULT_PREVIEW_CAP);
    const hiddenChars = result.text.length - preview.length;
    return {
      kind: "tool_result",
      ...(result.toolUseId ? { callId: result.toolUseId } : {}),
      preview,
      hiddenChars: hiddenChars > 0 ? hiddenChars : undefined,
      hiddenLines: hiddenChars > 0 ? (result.text.slice(TOOL_RESULT_PREVIEW_CAP).match(/\n/g) ?? []).length : undefined,
    };
  });
}

export function publishMessage(projection: LiveAgentProjection, message: LiveMessage): void {
  // LiveAgentProjection stores what it is handed by reference and bumps
  // `revision` only when the persisted event differs from the new one. We
  // accumulate text by mutating the message's block objects in place, so a
  // fresh (shallow-cloned) block array must be handed over each time or the
  // projection would compare the same object to itself and skip every delta.
  projection.upsert({
    id: message.id,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ts: message.ts,
    type: "assistant",
    phase: message.phase,
    blocks: message.blocks.map((block) => ({ ...block })),
    ...(message.cacheHit ? { cacheHit: message.cacheHit } : {}),
  });
}

/**
 * What one stream event does to the message a flow is building.
 *
 * `usage` is the backend's per-session usage map rather than a copy, because a
 * `message_delta` carries token counts without the model name and has to read the
 * name back off the record `message_start` wrote.
 */
export function applyStreamEvent(
  projection: LiveAgentProjection,
  usage: Map<string, TokenUsage>,
  sessionId: string,
  flowId: string,
  context: { message: LiveMessage | null },
  event: AnthropicStreamEvent,
  ts: number,
): void {
  switch (event.kind) {
    case "message_start": {
      const messageId = typeof event.message.id === "string" && event.message.id
        ? event.message.id
        : undefined;
      context.message = {
        id: `claude-live:${messageId ?? flowId}`,
        ...(messageId ? { messageId } : {}),
        ts,
        phase: "streaming",
        blocks: [],
        toolRaw: new Map(),
      };
      const model = typeof event.message.model === "string" ? event.message.model : undefined;
      const started = usageFor(model, event.message.usage, ts);
      if (started) usage.set(sessionId, started);
      projection.setState("running");
      publishMessage(projection, context.message);
      break;
    }
    case "content_block_start": {
      const message = context.message;
      if (!message) break;
      const block = blockForStart(event.contentBlock);
      message.blocks[event.index] = block;
      publishMessage(projection, message);
      break;
    }
    case "content_block_delta": {
      const message = context.message;
      if (!message) break;
      const block = message.blocks[event.index];
      const delta = event.delta;
      if (delta && typeof delta === "object") {
        if (typeof delta.text === "string") {
          const textBlock = block ?? { kind: "text", text: "" };
          if (textBlock.kind === "text" || textBlock.kind === "reasoning") {
            textBlock.text = `${textBlock.text ?? ""}${delta.text}`;
            message.blocks[event.index] = textBlock;
          }
        } else if (typeof delta.thinking === "string") {
          const reasoningBlock = block ?? { kind: "reasoning", text: "" };
          if (reasoningBlock.kind === "reasoning" || reasoningBlock.kind === "text") {
            reasoningBlock.text = `${reasoningBlock.text ?? ""}${delta.thinking}`;
            message.blocks[event.index] = reasoningBlock;
          }
        } else if (typeof delta.partial_json === "string") {
          message.toolRaw.set(event.index, `${message.toolRaw.get(event.index) ?? ""}${delta.partial_json}`);
        }
      }
      publishMessage(projection, message);
      break;
    }
    case "content_block_stop": {
      const message = context.message;
      if (!message) break;
      const raw = message.toolRaw.get(event.index);
      const block = message.blocks[event.index];
      if (block?.kind === "tool_use" && typeof raw === "string" && raw) {
        try {
          block.input = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Incomplete input_json: leave the block without an input rather than dropping it.
        }
        // The row's header and the sticky bar both read `summary`, so without it a live Bash row
        // said only "Bash" until the durable row replaced it. Same summarizer as the durable
        // parser, so the hand-off does not change the line.
        block.summary = summarizeToolUse(block.tool ?? "tool", block.input);
        message.toolRaw.delete(event.index);
      }
      publishMessage(projection, message);
      break;
    }
    case "message_delta": {
      const message = context.message;
      if (!message) break;
      const model = usage.get(sessionId)?.model;
      const delivered = usageFor(model, event.usage, ts);
      if (delivered) usage.set(sessionId, delivered);
      const cacheHit = extractClaudeCacheHit(event.usage);
      if (cacheHit) message.cacheHit = cacheHit;
      break;
    }
    case "message_stop": {
      const message = context.message;
      if (!message) break;
      message.phase = "complete";
      message.toolRaw.clear();
      projection.setState("idle");
      publishMessage(projection, message);
      break;
    }
    case "error": {
      const message = context.message;
      if (message) {
        message.phase = "complete";
        message.blocks.push({ kind: "metadata", label: "Agent error", text: "stream ended with an API error" });
        publishMessage(projection, message);
      }
      projection.setState("error");
      break;
    }
    case "ping":
      break;
  }
}

function blockForStart(contentBlock: { type?: unknown; name?: unknown; id?: unknown }): ActivityBlock {
  switch (contentBlock.type) {
    case "thinking":
      return { kind: "reasoning", text: "" };
    case "tool_use":
      return {
        kind: "tool_use",
        tool: typeof contentBlock.name === "string" ? contentBlock.name : "tool",
        input: {},
        ...(typeof contentBlock.id === "string" && contentBlock.id ? { callId: contentBlock.id } : {}),
      };
    case "text":
    default:
      return { kind: "text", text: "" };
  }
}
