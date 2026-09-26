// The turn being written, assembled from the serve's own deltas.
//
// The serve publishes prose and thinking as they are written: `session.reasoning.*` and
// `session.text.*` each open a part, carry a chunk per delta, and close with the whole part
// when there is one. The durable message only exists once the step ends. So before this, a
// row for a message mid-flight could only be drawn by re-reading the newest page of messages,
// coalesced into one read every 300ms: the text arrived in jumps, and every jump re-read and
// re-mapped 200 messages to move one line of it.
//
// So the serve's events are the read. This holds the parts of each running message, in the
// order the serve opened them, and hands back a message shaped exactly like the durable one,
// which means the existing mapper draws the streamed row with the same rules as the settled
// row -- and the durable read replaces it by id, in place, with nothing to move.
//
// What this deliberately does NOT do is finish a message. A streamed message never carries
// `time.completed`, so its row reads as streaming however long the text runs; the durable read
// at the end of the step is what closes it, and that read is also what brings the tool parts,
// tokens and cost the deltas never name. A row that says "still being written" is the truth
// of what this holds.

import type { SessionMessage } from "@opencode-ai/sdk/v2/client";

/** Which kind of part a delta belongs to, named as the serve names its events. */
export type OpencodeStreamedKind = "reasoning" | "text";

/** One serve event about one part of one running message, in the serve's own words. */
export interface OpencodeStreamedPart {
  kind: OpencodeStreamedKind;
  phase: "started" | "delta" | "ended";
  messageId: string;
  /**
   * The part's position among parts of its own kind, which is all the serve says: a message
   * with reasoning then text numbers both 0.
   */
  ordinal: number;
  /** One chunk, on `delta`. */
  chunk?: string;
  /** The whole part, on `ended`, where the serve has one. */
  text?: string;
}

interface StreamedPart {
  type: OpencodeStreamedKind;
  text: string;
}

interface RunningMessage {
  id: string;
  createdAt: number;
  /** Content order, which is the order the serve opened the parts in. */
  content: StreamedPart[];
  /** `<kind>:<ordinal>` to the part, so a delta finds the part it extends. */
  byKey: Map<string, StreamedPart>;
}

/**
 * A backstop on the number of sessions holding a running message.
 *
 * The map is keyed by session and a session runs one turn at a time, so this is a cap on owned
 * sessions rather than on a turn's length: a turn is many messages, one per step, and each new
 * message id replaces what was there. The bound is a number of sessions this process could
 * already be holding, and a reader opening mid-turn must not find its live row missing, so it
 * is loose. Reaching it drops the oldest session's message, which its next read redraws.
 */
const MAX_RUNNING_SESSIONS = 24;

export class OpencodeStreamTail {
  private readonly running = new Map<string, RunningMessage>();

  /**
   * Folds one serve event in and returns a message to draw, or null when there is nothing new
   * to show yet.
   *
   * Null is the common answer and each case is deliberate: a `started` names a part that has no
   * words yet, and drawing an empty row that fills in a moment later is a flash, not a stream.
   * A `delta` for a part this tail never saw open has no base text to extend -- the sidecar was
   * not watching when the serve opened it -- and guessing one would drop the words that came
   * before, so the durable read is left to settle it. And an `ended` with no words at all is a
   * provider that keeps its thinking encrypted, which is a part that exists and reads empty,
   * the same thing the durable mapper draws for it.
   */
  apply(
    sessionId: string,
    part: OpencodeStreamedPart,
    now: number,
  ): SessionMessage | null {
    const message = this.messageFor(sessionId, part, now);
    const key = `${part.kind}:${part.ordinal}`;
    const streamed = message.byKey.get(key);
    if (!streamed) {
      // A delta for a part that was never opened here, and an `ended` for one that was
      // forgotten. Both mean this tail missed the start, and neither can be drawn honestly.
      if (part.phase === "delta" || part.phase === "ended") return null;
      message.content.push({ type: part.kind, text: "" });
      message.byKey.set(key, message.content[message.content.length - 1]!);
      return null;
    }
    if (part.phase === "delta" && part.chunk) streamed.text += part.chunk;
    // The serve's own closing text wins where it has one: it is the whole part rather than an
    // accumulation, so it is the authority on anything the deltas dropped or reordered. It is
    // also empty on an encrypted-thinking provider, which is why this is not an assignment.
    if (part.phase === "ended" && part.text) streamed.text = part.text;
    if (!message.content.some((entry) => entry.text)) return null;
    // Shaped like the durable message and nothing more, because that is all the mapper reads:
    // `type` to pick the branch, `time.created` to order the row, `content` for the blocks.
    // The parts are copied so a row the mapper is holding cannot change under it on the next
    // delta, and there is no `time.completed` -- see the file header for why a streamed
    // message never closes itself.
    return {
      id: message.id,
      type: "assistant",
      time: { created: message.createdAt },
      content: message.content.map((entry) => ({ type: entry.type, text: entry.text })),
    } as unknown as SessionMessage;
  }

  /**
   * Forgets a running message once a durable read has answered for it.
   *
   * The point of the handoff is that the tail holds nothing the serve has already written, so
   * this is called with every message a refresh folded in rather than with the turn that ended:
   * a refresh answers for whatever it read, and around a compaction a message can be read long
   * after the step that wrote it. A forgotten message is rebuilt if the serve publishes for it
   * again, so an event that arrives out of order costs one redraw rather than a wrong row.
   */
  forget(sessionId: string, read: readonly { id: string }[]): void {
    const message = this.running.get(sessionId);
    if (!message) return;
    for (const candidate of read) {
      if (candidate.id === message.id) {
        this.running.delete(sessionId);
        return;
      }
    }
  }

  /** Drops everything for a session that is no longer owned. */
  clear(sessionId: string): void {
    this.running.delete(sessionId);
  }

  /** Drops every session, for the pool going away. */
  clearAll(): void {
    this.running.clear();
  }

  private messageFor(
    sessionId: string,
    part: OpencodeStreamedPart,
    now: number,
  ): RunningMessage {
    const existing = this.running.get(sessionId);
    if (existing && existing.id === part.messageId) return existing;
    // One running message per session, because a session runs one turn at a time. A new
    // message id therefore replaces what was there, which also retires a message whose
    // durable read never arrived.
    const message: RunningMessage = {
      id: part.messageId,
      createdAt: now,
      content: [],
      byKey: new Map(),
    };
    this.running.set(sessionId, message);
    this.trim();
    return message;
  }

  private trim(): void {
    while (this.running.size > MAX_RUNNING_SESSIONS) {
      const oldest = this.running.keys().next();
      if (oldest.done) return;
      this.running.delete(oldest.value);
    }
  }
}
