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
 * Keys a message's parts the way the serve names them, by position among parts of the same kind.
 *
 * One place, because a delta finds its part by this key and the durable merge lines the two
 * records up by it. If they disagreed, a merge would write a part into the row under a key the
 * next delta does not read, and the text that followed would land in a second block.
 */
function partsByKey(parts: readonly StreamedPart[]): Map<string, StreamedPart> {
  const byKey = new Map<string, StreamedPart>();
  const counts = new Map<string, number>();
  for (const part of parts) {
    const ordinal = counts.get(part.type) ?? 0;
    counts.set(part.type, ordinal + 1);
    byKey.set(`${part.type}:${ordinal}`, part);
  }
  return byKey;
}

/** True once the serve has written the whole message, which is the handoff. */
function isFinished(message: SessionMessage): boolean {
  return (message as { time?: { completed?: number } }).time?.completed !== undefined;
}

/**
 * The newest assistant message the serve is still writing, or null when it has finished them all.
 *
 * A read is chronological, so the last unfinished assistant in it is the one in flight. Anything
 * else would adopt a message the serve finished, and stream onto a row that is already whole.
 */
function newestUnfinishedAssistant(read: readonly SessionMessage[]): SessionMessage | null {
  for (let index = read.length - 1; index >= 0; index -= 1) {
    const message = read[index]!;
    if (message.type !== "assistant") continue;
    if (isFinished(message)) return null;
    return message;
  }
  return null;
}

/** A running message that starts from what the serve has already written for it. */
function seededFrom(durable: SessionMessage): RunningMessage {
  const parts = (durable as { content?: { type?: string; text?: string }[] }).content ?? [];
  const content: StreamedPart[] = [];
  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue;
    content.push({ type: part.type, text: part.text ?? "" });
  }
  return {
    id: durable.id,
    createdAt: (durable as { time: { created: number } }).time.created,
    content,
    byKey: partsByKey(content),
  };
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
   * Folds a durable read into what is being streamed, rather than obeying it.
   *
   * The serve inserts a message into its history while the step is still writing it, so a read
   * that names the running message is not a record OF it -- it is a snapshot of a row mid-write.
   * Treating the first such read as the answer is what made a running turn lose its thinking: the
   * tail dropped, the next delta rebuilt a message holding only the part it had seen since, and
   * that thinner record replaced a row which had a reasoning block in it. The block came back
   * when the step ended, which is what a reader sees as the tail being overwritten and then
   * settling on the durable text.
   *
   * So a read is the STARTING RECORD for the stream, not the end of it, in three cases:
   *
   * - The message we hold is drawn complete. Then it is the whole story -- that read brought the
   *   tool parts, tokens and cost, and the serve publishes nothing more for it -- so it is
   *   dropped and the stream is over for it.
   * - The read draws a message still being written, whether or not the tail holds it. It is
   *   adopted, so a delta arriving afterwards extends what the row already shows instead of
   *   replacing it with the one part the delta alone knows about. This is the case the live turn
   *   showed: the read drew a thinking line, and the first text delta would otherwise have drawn
   *   a row with no thinking in it.
   * - The read draws nothing unfinished, which means it has not caught up with the stream. What
   *   the tail holds is then the better record and is kept untouched.
   *
   * Where both know a part, the longer text wins, because a read can be behind the stream still
   * writing it and the stream is the one being watched; a read can also carry words no delta ever
   * sent, which is the other way round, and the same rule takes them.
   */
  settle(sessionId: string, read: readonly SessionMessage[]): void {
    const running = this.running.get(sessionId);
    const held = running ? read.find((message) => message.id === running.id) : undefined;
    if (running && held && isFinished(held)) {
      this.running.delete(sessionId);
      return;
    }
    const unfinished = newestUnfinishedAssistant(read);
    if (!unfinished) return;
    if (running && running.id === unfinished.id) {
      this.mergeDurable(running, unfinished);
      return;
    }
    // Either nothing was held, or the serve has opened a newer step than the one we hold: the
    // durable record for the one being written now is the better place to start.
    this.running.set(sessionId, seededFrom(unfinished));
    this.trim();
  }

  private mergeDurable(running: RunningMessage, durable: SessionMessage): void {
    const parts = (durable as { content?: { type?: string; text?: string }[] }).content ?? [];
    const merged: StreamedPart[] = [];
    const emitted = new Set<string>();
    const counts = new Map<string, number>();
    for (const part of parts) {
      if (part.type !== "text" && part.type !== "reasoning") continue;
      // A part is named by its position among parts of its own kind, which is how the serve
      // numbers the deltas too, so the two records can be lined up part for part.
      const ordinal = counts.get(part.type) ?? 0;
      counts.set(part.type, ordinal + 1);
      const key = `${part.type}:${ordinal}`;
      emitted.add(key);
      const streamed = running.byKey.get(key);
      const durableText = part.text ?? "";
      merged.push({
        type: part.type,
        // Longer wins, and only because longer is a real signal: a durable read can be behind
        // the stream still writing this part, and the stream is the one being watched.
        text: (streamed?.text.length ?? 0) > durableText.length ? streamed!.text : durableText,
      });
    }
    // Parts the durable message does not name are parts the serve has not written yet, so the
    // stream is the only record of them. Appended in the order the tail opened them.
    for (const [key, part] of running.byKey) {
      if (!emitted.has(key)) merged.push(part);
    }
    running.content = merged;
    running.byKey = partsByKey(merged);
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

  /** True when this tail is holding a part of the running message, for the tests that ask. */
  holds(sessionId: string, messageId: string): boolean {
    return this.running.get(sessionId)?.id === messageId;
  }

  private trim(): void {
    while (this.running.size > MAX_RUNNING_SESSIONS) {
      const oldest = this.running.keys().next();
      if (oldest.done) return;
      this.running.delete(oldest.value);
    }
  }
}
