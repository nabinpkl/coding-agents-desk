// What one observed websocket message does to the rows a codex turn is building,
// and what a finished response reports about tokens.

import { contextWindowFor } from "@/config";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import type { EventCacheHit, TokenUsage } from "@/transcripts/sources/transcriptTypes";
import type { CodexMessageEvent } from "@/live/codexNetworkSource";
import type { FlowContext } from "@/live/codexLiveFlows";
import { blockForItem, publishTurnInput, type CodexItemStore } from "@/live/codexLiveItems";

// Cached input tokens from the Responses-API usage shape the codex websocket
// publishes on `response.completed`. The transcript's `token_count` record
// normalizes this to a flat `cached_input_tokens`; the API shape nests it under
// `input_tokens_details.cached_tokens`. Both are accepted so a drift in either
// representation still feeds the badge. Undefined when neither is present, so
// a missing cache field never fabricates a 0% badge.
function cachedInputTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage.input_tokens_details;
  const nested = details && typeof details === "object"
    ? (details as Record<string, unknown>).cached_tokens
    : undefined;
  const flat = usage.cached_input_tokens;
  const value = typeof nested === "number" ? nested : flat;
  return typeof value === "number" && value >= 0 ? value : undefined;
}

export function usageFor(model: string | undefined, usage: unknown, ts: number): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const total = typeof u.total_tokens === "number" ? u.total_tokens : 0;
  // `total_tokens` already includes the cached portion: `input_tokens` counts
  // the full prompt, with `cached_tokens` a subset of it. This mirrors the
  // durable transcript adapter, where the meter is `total_tokens` as published.
  const current = total > 0 ? total : input + output;
  if (current <= 0) return null;
  return {
    current,
    limit: contextWindowFor(model),
    updatedAt: ts || Date.now(),
    ...(model ? { model } : {}),
  };
}

// Per-turn prompt-cache summary for the cache-hit badge. `input` is the full
// prompt (`input_tokens` already includes the cached portion), so the fraction
// `cached / input` is the true cache-hit rate. Both numbers must be present;
// a usage record without cache info reports no badge.
export function cacheHitFor(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cached = cachedInputTokens(u);
  if (input <= 0 || cached === undefined) return undefined;
  return { cached, input };
}

/** Completes every row still mid-stream on a flow, which is what a closed socket means. */
export function finishStreaming(store: CodexItemStore, context: FlowContext): void {
  for (const itemId of [...context.streaming]) {
    store.complete(context.sessionId, itemId);
  }
  context.streaming.clear();
}

/**
 * `usage` is the backend's per-session usage map rather than a copy, matching the
 * claude mirror: the record is read back as well as written.
 */
export function applyCodexEvent(
  projection: LiveAgentProjection,
  store: CodexItemStore,
  usage: Map<string, TokenUsage>,
  sessionId: string,
  context: FlowContext,
  event: CodexMessageEvent,
  ts: number,
): void {
  switch (event.kind) {
    case "response_create":
      projection.setState("running");
      publishTurnInput(projection, event.input, ts);
      break;
    case "response_created":
    case "response_in_progress":
      projection.setState("running");
      break;
    case "output_item_added": {
      const item = event.item;
      const itemId = typeof item.id === "string" && item.id ? item.id : null;
      const block = blockForItem(item);
      if (!itemId || !block) break;
      context.streaming.add(itemId);
      store.upsert(sessionId, itemId, ts, "streaming", [block]);
      break;
    }
    case "output_text_delta": {
      const itemId = event.itemId;
      if (typeof itemId !== "string") break;
      const delta = event.delta;
      if (typeof delta !== "string" || delta.length === 0) break;
      const current = store.get(sessionId, itemId);
      if (!current) break;
      const textBlock = current.blocks[0];
      if (textBlock?.kind === "text") {
        textBlock.text = `${textBlock.text ?? ""}${delta}`;
        store.upsert(sessionId, itemId, current.ts, current.phase, current.blocks);
      }
      break;
    }
    case "output_text_done": {
      const itemId = event.itemId;
      if (typeof itemId !== "string") break;
      const current = store.get(sessionId, itemId);
      if (!current) break;
      const text = typeof event.text === "string" ? event.text : current.blocks[0]?.text;
      const block = current.blocks[0];
      if (block?.kind === "text") block.text = text ?? block.text;
      context.streaming.delete(itemId);
      store.upsert(sessionId, itemId, current.ts, "complete", current.blocks);
      break;
    }
    case "reasoning_summary_text_delta": {
      const itemId = event.itemId;
      if (typeof itemId !== "string") break;
      const delta = event.delta;
      if (typeof delta !== "string" || delta.length === 0) break;
      const current = store.get(sessionId, itemId);
      if (!current) break;
      const block = current.blocks[0];
      if (block?.kind === "reasoning") {
        block.text = `${block.text ?? ""}${delta}`;
        store.upsert(sessionId, itemId, current.ts, current.phase, current.blocks);
      }
      break;
    }
    case "reasoning_summary_text_done": {
      const itemId = event.itemId;
      if (typeof itemId !== "string") break;
      const current = store.get(sessionId, itemId);
      if (!current) break;
      const text = typeof event.text === "string" ? event.text : current.blocks[0]?.text;
      const block = current.blocks[0];
      if (block?.kind === "reasoning") block.text = text ?? block.text;
      context.streaming.delete(itemId);
      store.upsert(sessionId, itemId, current.ts, "complete", current.blocks);
      break;
    }
    case "function_call_arguments_delta": {
      const itemId = event.itemId;
      if (typeof itemId !== "string") break;
      const delta = event.delta;
      if (typeof delta !== "string") break;
      const current = store.get(sessionId, itemId);
      if (!current) break;
      if (!current.toolRaw) current.toolRaw = new Map();
      current.toolRaw.set(itemId, `${current.toolRaw.get(itemId) ?? ""}${delta}`);
      break;
    }
    case "function_call_arguments_done": {
      const itemId = event.itemId;
      if (typeof itemId !== "string") break;
      const current = store.get(sessionId, itemId);
      if (!current) break;
      const raw = typeof event.arguments === "string" ? event.arguments : current.toolRaw?.get(itemId);
      const block = current.blocks[0];
      if (block?.kind === "tool_use" && typeof raw === "string" && raw) {
        try {
          block.input = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Incomplete arguments: leave the block without an input rather than dropping it.
        }
      }
      current.toolRaw?.delete(itemId);
      context.streaming.delete(itemId);
      store.upsert(sessionId, itemId, current.ts, "complete", current.blocks);
      break;
    }
    case "output_item_done": {
      const itemId = event.item.id;
      if (typeof itemId !== "string") break;
      context.streaming.delete(itemId);
      const current = store.get(sessionId, itemId);
      if (!current || current.phase === "complete") break;
      store.upsert(sessionId, itemId, current.ts, "complete", current.blocks);
      break;
    }
    case "response_completed": {
      const response = event.response && typeof event.response === "object"
        ? event.response as Record<string, unknown>
        : {};
      const model = typeof response.model === "string" ? response.model : undefined;
      const reported = usageFor(model, response.usage, ts);
      if (reported) usage.set(sessionId, reported);
      const cacheHit = cacheHitFor(response.usage);
      if (cacheHit) {
        // Re-upsert the turn's last assistant row with the badge, the same
        // way the durable path re-stamps a `token_count` line onto the last
        // content event. The projection upserts by id and bumps `revision`,
        // so the panel replaces the row rather than duplicating it.
        const lastId = store.lastContentId(sessionId);
        const lastItem = lastId !== undefined ? store.get(sessionId, lastId) : undefined;
        if (lastItem && lastId !== undefined) {
          store.upsert(sessionId, lastId, lastItem.ts, lastItem.phase, lastItem.blocks, cacheHit);
        }
      }
      finishStreaming(store, context);
      const error = response.error;
      if (error && typeof error === "object") {
        projection.setState("error");
      } else {
        projection.setState("idle");
      }
      break;
    }
    case "ack":
    case "ping":
    case "pong":
    case "server_message":
      break;
  }
}
