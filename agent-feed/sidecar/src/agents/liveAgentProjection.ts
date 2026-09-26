import { randomUUID } from "node:crypto";
import type {
  ActivityBlock,
  ActivityEvent,
  ParsedLine,
} from "@/transcripts/transcriptTypes";
import type {
  AgentQueueState,
  AgentRunState,
  TimelineEnvelope,
} from "@agentdesk/agent-feed-wire";

// The projection produces these, the HTTP layer publishes them verbatim, and the
// Agent Panel parses them from the same declaration. See agent-feed/wire.
export type {
  AgentQueueState,
  AgentRunState,
  TimelineEnvelope,
} from "@agentdesk/agent-feed-wire";

type ProjectionEvent = ParsedLine & {
  id: string;
  phase: ActivityEvent["phase"];
};

type ProjectionListener = (envelope: TimelineEnvelope) => void;

export class LiveAgentProjection {
  /**
   * Identity of this projection instance, carried on every envelope.
   *
   * A reconnect to the same sidecar keeps the instance, so its rows may be merged. A sidecar
   * restart builds a new one even when the underlying session is the same, and the panel must
   * treat that as a replacement boundary.
   */
  private currentProjectionId: string;
  private replacing = false;
  private readonly replayLimit: number;
  private readonly items = new Map<string, ActivityEvent>();
  private readonly order: string[] = [];
  private readonly replay: TimelineEnvelope[] = [];
  private readonly listeners = new Set<ProjectionListener>();
  private sequence = 0;
  private currentRunState: AgentRunState = "idle";
  private currentQueue: AgentQueueState = { steer: 0, followUp: 0 };

  constructor(options: { replayLimit?: number; projectionId?: string } = {}) {
    this.currentProjectionId = options.projectionId ?? randomUUID();
    this.replayLimit = options.replayLimit ?? 256;
    if (!Number.isSafeInteger(this.replayLimit) || this.replayLimit < 1) {
      throw new Error("replayLimit must be a positive integer");
    }
  }

  get projectionId(): string {
    return this.currentProjectionId;
  }

  get total(): number {
    return this.order.length;
  }

  get runState(): AgentRunState {
    return this.currentRunState;
  }

  get queue(): AgentQueueState {
    return { ...this.currentQueue };
  }

  upsert(input: ProjectionEvent): ActivityEvent {
    const current = this.items.get(input.id);
    const candidate: ActivityEvent = {
      ...input,
      index: current?.index ?? this.order.length,
      revision: current ? current.revision + 1 : 0,
    };
    if (current && sameEventContent(current, candidate)) return current;
    if (!current) this.order.push(input.id);
    this.items.set(input.id, candidate);
    if (!this.replacing) this.publish("upsert", [candidate]);
    return candidate;
  }

  /**
   * Rebuilds the projection from a complete history read.
   *
   * A compaction or fork can make the serve's message set differ from the one this projection
   * was built from. Upserting the new tail into the old map keeps rows that no longer exist and
   * leaves the panel showing the wrong turn as the session's last line. A full read is therefore a
   * replacement boundary: it rotates the projection id and publishes one snapshot, so a subscriber
   * drops the old window instead of merging it.
   */
  replace(build: () => void): void {
    const previous = {
      projectionId: this.currentProjectionId,
      items: new Map(this.items),
      order: [...this.order],
      replay: [...this.replay],
    };
    this.currentProjectionId = randomUUID();
    this.items.clear();
    this.order.length = 0;
    this.replay.length = 0;
    this.replacing = true;
    try {
      build();
    } catch (error) {
      this.currentProjectionId = previous.projectionId;
      this.items.clear();
      for (const [id, item] of previous.items) this.items.set(id, item);
      this.order.length = 0;
      this.order.push(...previous.order);
      this.replay.length = 0;
      this.replay.push(...previous.replay);
      throw error;
    } finally {
      this.replacing = false;
    }
    this.publish("snapshot", this.page(Math.max(0, this.total - 100), 100));
  }

  setState(runState: AgentRunState, queue: AgentQueueState = this.currentQueue): void {
    if (
      runState === this.currentRunState &&
      queue.steer === this.currentQueue.steer &&
      queue.followUp === this.currentQueue.followUp
    ) return;
    this.currentRunState = runState;
    this.currentQueue = { ...queue };
    this.publish("state", []);
  }

  /**
   * Publishes the current state unconditionally, for a change no row carries.
   *
   * A model switch lands on no message: the serve publishes `session.model.selected` and the
   * next `session.get` names the new model, but the message set is untouched, so `upsert`
   * publishes nothing and `setState` sees the same idle it already holds. Without this the
   * HTTP layer's per-envelope model stamp has nothing to ride on, and an open stream never
   * learns the switch -- measured 2026-09-26, a footer that kept the previous model until the
   * next turn. The envelope carries no events, only a newer sequence and the current state.
   */
  announce(): void {
    this.publish("state", []);
  }

  page(offset: number, limit: number): ActivityEvent[] {
    const start = Math.max(0, offset);
    const end = Math.min(this.order.length, start + Math.max(0, limit));
    return this.order.slice(start, end).flatMap((id) => {
      const event = this.items.get(id);
      return event ? [event] : [];
    });
  }

  subscribe(afterSequence: number, listener: ProjectionListener): () => void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a nonnegative integer");
    }
    const oldest = this.replay[0]?.sequence ?? this.sequence + 1;
    if (afterSequence < oldest - 1) {
      listener(this.snapshot(Math.max(0, this.total - 100), 100));
    } else {
      for (const envelope of this.replay) {
        if (envelope.sequence > afterSequence) listener(envelope);
      }
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(offset = 0, limit = 100): TimelineEnvelope {
    const start = Math.max(0, Math.min(offset, this.total));
    return {
      kind: "snapshot",
      sequence: this.sequence,
      mode: "nice",
      events: this.page(start, limit),
      windowStart: start,
      total: this.total,
      runState: this.currentRunState,
      queue: this.queue,
      projectionId: this.projectionId,
    };
  }

  private publish(kind: TimelineEnvelope["kind"], events: ActivityEvent[]): void {
    const envelope: TimelineEnvelope = {
      kind,
      sequence: ++this.sequence,
      mode: "nice",
      events,
      windowStart: events[0]?.index ?? Math.max(0, this.total - 100),
      total: this.total,
      runState: this.currentRunState,
      queue: this.queue,
      projectionId: this.projectionId,
    };
    this.replay.push(envelope);
    if (this.replay.length > this.replayLimit) this.replay.shift();
    for (const listener of this.listeners) listener(envelope);
  }
}

function sameEventContent(left: ActivityEvent, right: ActivityEvent): boolean {
  return left.ts === right.ts &&
    left.type === right.type &&
    left.phase === right.phase &&
    JSON.stringify(left.blocks) === JSON.stringify(right.blocks) &&
    // A late cache badge (Codex `response.completed` re-stamp) must count as a
    // content change or the upsert would be skipped and the badge never shown.
    JSON.stringify(left.cacheHit) === JSON.stringify(right.cacheHit);
}

export interface AgentValueLimits {
  maximumBytes: number;
  maximumDepth: number;
  maximumProperties: number;
}

const DEFAULT_VALUE_LIMITS: AgentValueLimits = {
  maximumBytes: 50 * 1024,
  maximumDepth: 8,
  maximumProperties: 256,
};
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeAgentValue(
  value: unknown,
  limits: Partial<AgentValueLimits> = {},
): unknown {
  const resolved = { ...DEFAULT_VALUE_LIMITS, ...limits };
  const seen = new WeakSet<object>();
  let properties = 0;

  const visit = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean" || typeof input === "number") {
      return input;
    }
    if (typeof input === "string") return input;
    if (typeof input === "bigint") return input.toString();
    if (typeof input !== "object") return String(input);
    if (seen.has(input)) return "[circular]";
    if (depth >= resolved.maximumDepth) return "[depth truncated]";
    seen.add(input);
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      for (const item of input) {
        if (++properties > resolved.maximumProperties) {
          result.push("[properties truncated]");
          break;
        }
        result.push(visit(item, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(input)) {
      if (BLOCKED_KEYS.has(key)) continue;
      if (++properties > resolved.maximumProperties) {
        result.truncated = "[properties truncated]";
        break;
      }
      result[key] = visit(item, depth + 1);
    }
    return result;
  };

  const sanitized = visit(value, 0);
  const encoded = JSON.stringify(sanitized);
  if (new TextEncoder().encode(encoded).byteLength <= resolved.maximumBytes) {
    return sanitized;
  }
  return { truncated: "[byte limit truncated]" };
}

export function blocksFromUnknown(value: unknown): ActivityBlock[] {
  const sanitized = sanitizeAgentValue(value);
  return [{ kind: "metadata", text: JSON.stringify(sanitized) }];
}
