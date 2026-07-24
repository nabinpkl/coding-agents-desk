import type { ActivityBlock, ActivityEvent } from "./useSessionEventsStream";

const KNOWN_BLOCK_KINDS = new Set<ActivityBlock["kind"]>([
  "text",
  "tool_use",
  "tool_result",
  "reasoning",
  "compaction",
  "metadata",
  "plain",
  "raw",
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
  };
}

export function normalizeActivityEvent(value: unknown): ActivityEvent {
  const source = record(value);
  const blocks = Array.isArray(source?.blocks)
    ? source.blocks.map(normalizeActivityBlock)
    : [{ kind: "plain", label: "Plain", text: plainText(value) } satisfies ActivityBlock];
  const rawType = source?.type;
  return {
    index: typeof source?.index === "number" ? source.index : -1,
    ts: typeof source?.ts === "number" ? source.ts : 0,
    type:
      typeof rawType === "string" && KNOWN_EVENT_TYPES.has(rawType as ActivityEvent["type"])
        ? (rawType as ActivityEvent["type"])
        : "system",
    blocks,
  };
}

export function normalizeEventsPage(value: unknown): { events: ActivityEvent[]; total: number } {
  const source = record(value);
  const events = Array.isArray(source?.events)
    ? source.events.map(normalizeActivityEvent)
    : [];
  return {
    events,
    total: typeof source?.total === "number" ? source.total : events.length,
  };
}
