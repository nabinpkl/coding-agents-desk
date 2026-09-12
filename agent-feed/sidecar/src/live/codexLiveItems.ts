// The assistant rows a codex turn is building, keyed by the item id codex gives them.
//
// A codex response arrives as a stream of per-item events -- one item per reasoning
// summary, prose message, or function call -- and each item is upserted into the
// projection repeatedly as its text accumulates. The store is what remembers a row
// between those events, so a delta has something to append to and an abruptly closed
// socket has something to complete.

import { LiveAgentProjection } from "../agents/liveAgentProjection.ts";
import type { ActivityBlock, EventCacheHit } from "../transcripts/sources/transcriptTypes.ts";

const TOOL_RESULT_PREVIEW_CAP = 16_000;

export interface LiveItem {
  id: string;
  ts: number;
  phase: "streaming" | "complete";
  blocks: ActivityBlock[];
  toolRaw?: Map<string, string>;
}

export class CodexItemStore {
  /** In-flight item rows, keyed `sessionId` -> `itemId`, so stream state survives flow churn. */
  private readonly items = new Map<string, Map<string, LiveItem>>();
  /** Last assistant row upserted per session, so `response.completed` can stamp it with the cache badge. */
  private readonly lastContent = new Map<string, string>();

  constructor(private readonly projectionFor: (sessionId: string) => LiveAgentProjection) {}

  get(sessionId: string, itemId: string): LiveItem | undefined {
    return this.items.get(sessionId)?.get(itemId);
  }

  /** The id of the session's last prose row, which is where a cache badge belongs. */
  lastContentId(sessionId: string): string | undefined {
    return this.lastContent.get(sessionId);
  }

  complete(sessionId: string, itemId: string): void {
    const current = this.items.get(sessionId)?.get(itemId);
    if (!current || current.phase === "complete") return;
    this.upsert(sessionId, itemId, current.ts, "complete", current.blocks);
  }

  /** Drops a session's rows. Handed to the session registry as its `forget`. */
  forget(sessionId: string): void {
    this.items.delete(sessionId);
    this.lastContent.delete(sessionId);
  }

  upsert(
    sessionId: string,
    itemId: string,
    ts: number,
    phase: "streaming" | "complete",
    blocks: ActivityBlock[],
    cacheHit?: EventCacheHit,
  ): void {
    const bySession = this.items.get(sessionId) ?? new Map<string, LiveItem>();
    const current = bySession.get(itemId) ?? { id: itemId, ts, phase: "streaming", blocks: [] };
    current.ts = ts;
    current.phase = phase;
    current.blocks = blocks;
    bySession.set(itemId, current);
    this.items.set(sessionId, bySession);
    const projection = this.projectionFor(sessionId);
    projection.upsert({
      id: `codex-live:${itemId}`,
      // The codex item id (msg_.../rs_.../fc_...) is the same id the durable
      // rollout records carry, so the webview can hand the live tail off to
      // the durable row once both are complete.
      messageId: itemId,
      ts,
      type: "assistant",
      phase,
      blocks: blocks.map((block) => ({ ...block })),
      ...(cacheHit ? { cacheHit } : {}),
    });
    // The last prose row is where a `response.completed` cache summary belongs,
    // mirroring how the durable transcript re-stamps its `token_count` line
    // onto the turn's last text event (tool rows fold into clusters that
    // render no badge). Responses can end on a tool call, so an item with no
    // text leaves the previous prose row as the target.
    if (blocks.some((block) => block.kind === "text")) {
      this.lastContent.set(sessionId, itemId);
    }
  }
}

/** Publishes the user's turn input and tool results carried in `response.create`. */
export function publishTurnInput(projection: LiveAgentProjection, input: unknown, ts: number): void {
  if (!Array.isArray(input)) return;
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (item.type === "function_call_output") {
      const text = typeof item.output === "string" ? item.output : "";
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      const preview = text.slice(0, TOOL_RESULT_PREVIEW_CAP);
      const hiddenChars = text.length - preview.length;
      const blocks: ActivityBlock[] = [{
        kind: "tool_result",
        ...(callId ? { callId } : {}),
        preview,
        hiddenChars: hiddenChars > 0 ? hiddenChars : undefined,
        hiddenLines: hiddenChars > 0 ? (text.slice(TOOL_RESULT_PREVIEW_CAP).match(/\n/g) ?? []).length : undefined,
      }];
      projection.upsert({
        id: `codex-live:user:${item.id}`,
        messageId: item.id,
        ts,
        type: "user",
        phase: "complete",
        blocks,
      });
    } else if (item.type === "message" && item.role === "user") {
      const text = inputText(item.content);
      if (text.length === 0) continue;
      projection.upsert({
        id: `codex-live:user:${item.id}`,
        messageId: item.id,
        ts,
        type: "user",
        phase: "complete",
        blocks: [{ kind: "text", text }],
      });
    }
  }
}

/** The first block an added output item stands up as, or nothing for a type with no row. */
export function blockForItem(item: Record<string, unknown>): ActivityBlock | null {
  switch (item.type) {
    case "reasoning":
      return { kind: "reasoning", text: "" };
    case "message":
      return { kind: "text", text: "" };
    case "function_call":
      return {
        kind: "tool_use",
        tool: typeof item.name === "string" ? item.name : "tool",
        input: {},
        ...(typeof item.call_id === "string" && item.call_id ? { callId: item.call_id } : {}),
      };
    default:
      return null;
  }
}

function inputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const block = part as Record<string, unknown>;
      if (block.type === "input_text" && typeof block.text === "string") out += block.text;
    }
  }
  return out;
}
