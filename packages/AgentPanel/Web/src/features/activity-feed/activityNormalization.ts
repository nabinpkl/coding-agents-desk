import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

const KNOWN_BLOCK_KINDS = new Set<ActivityBlock["kind"]>([
  "text",
  "tool_use",
  "tool_result",
  "reasoning",
  "compaction",
  "metadata",
  "plain",
  "raw",
  "image",
]);

const KNOWN_EVENT_TYPES = new Set<ActivityEvent["type"]>([
  "user",
  "assistant",
  "reasoning",
  "system",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function normalizeActivityBlock(value: unknown): ActivityBlock {
  const source = record(value);
  if (!source) {
    return { kind: "plain", label: "Plain", text: plainText(value) };
  }
  const kind = source?.kind;
  if (typeof kind !== "string" || !KNOWN_BLOCK_KINDS.has(kind as ActivityBlock["kind"])) {
    return { kind: "plain", label: "Plain", text: plainText(value) };
  }
  const input = record(source.input) ?? undefined;
  return {
    kind: kind as ActivityBlock["kind"],
    label: optionalString(source.label),
    text: optionalString(source.text),
    tool: optionalString(source.tool),
    summary: optionalString(source.summary),
    input,
    preview: optionalString(source.preview),
    hiddenChars: typeof source.hiddenChars === "number" ? source.hiddenChars : undefined,
    hiddenLines: typeof source.hiddenLines === "number" ? source.hiddenLines : undefined,
    callId: optionalString(source.callId),
    mediaType: optionalString(source.mediaType),
  };
}

export function normalizeActivityEvent(value: unknown): ActivityEvent {
  const source = record(value);
  const blocks = Array.isArray(source?.blocks)
    ? source.blocks.map(normalizeActivityBlock)
    : [{ kind: "plain", label: "Plain", text: plainText(value) } satisfies ActivityBlock];
  const rawType = source?.type;
  const rawCacheHit = record(source?.cacheHit);
  const cached = typeof rawCacheHit?.cached === "number" ? rawCacheHit.cached : undefined;
  const hitInput = typeof rawCacheHit?.input === "number" ? rawCacheHit.input : undefined;
  return {
    id: typeof source?.id === "string" ? source.id : undefined,
    index: typeof source?.index === "number" ? source.index : -1,
    // Kept rather than dropped, for the reason `otherModeIndex` below gives: this rebuilds the
    // event field by field, and without it a transcript's rows could no longer say which of them
    // are neighbours.
    ...(source?.previous === null || typeof source?.previous === "number"
      ? { previous: source.previous }
      : {}),
    revision: typeof source?.revision === "number" ? source.revision : undefined,
    phase:
      source?.phase === "streaming" || source?.phase === "complete" || source?.phase === "error"
        ? source.phase
        : undefined,
    ts: typeof source?.ts === "number" ? source.ts : 0,
    type:
      typeof rawType === "string" && KNOWN_EVENT_TYPES.has(rawType as ActivityEvent["type"])
        ? (rawType as ActivityEvent["type"])
        : "system",
    blocks,
    // Absent and non-numeric both mean "no counterpart in the other view", which is
    // the truthful answer for a machinery line and the safe one for a peer that
    // predates modes. This function rebuilds the event field by field, so a field it
    // does not name is silently dropped -- which for this one would leave the mode
    // toggle with nothing to map the viewer's position through.
    otherModeIndex:
      typeof source?.otherModeIndex === "number" ? source.otherModeIndex : null,
    messageId: typeof source?.messageId === "string" ? source.messageId : undefined,
    // A cache summary is only meaningful with both counts present and sane; a
    // peer that emits one half is treated as reporting nothing.
    cacheHit:
      typeof cached === "number" && typeof hitInput === "number" && hitInput > 0
        ? { cached, input: hitInput }
        : undefined,
  };
}

export function normalizeEventsPage(value: unknown): { events: ActivityEvent[]; windowStart: number } {
  const source = record(value);
  const events = Array.isArray(source?.events)
    ? source.events.map(normalizeActivityEvent)
    : [];
  return {
    events,
    windowStart: typeof source?.windowStart === "number" ? source.windowStart : 0,
  };
}
