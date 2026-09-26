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
// What this hands back is the serve's own record with the stream's words ON TOP of it, never
// the stream alone and never the read alone. Both halves are needed and neither is a superset
// of the other:
//
// - The read is behind the stream. Measured on a live turn: the stream held 583 characters of
//   reasoning while the serve's own message read `reasoning: 0` with the shell part already
//   `running`, because the serve writes that part at the end. Mapping the read on its own drew
//   a row whose thinking had been replaced by the shell, and the thinking came back on the next
//   read. A read is a snapshot of a row mid-write, so it is the STARTING RECORD for a message
//   the serve is still writing, not the end of it.
// - The stream knows nothing the read does. A shell call's input, its state, its output, the
//   tokens and the cost are all in the durable record and none of it arrives on a delta, so a
//   row drawn from the stream alone drops the tool that a reader is watching run.
//
// So the row is built once, from both: the durable message's parts in the durable order, each
// text part's words taken from whichever record has more of them, and any part the serve has
// not written yet appended in the order the stream opened it. The invariant is that a message
// this draws is never thinner than the row it replaces, which is the whole bug: a streamed
// upsert that is missing what the reader already had reads as the feed losing the turn.
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

/** One part of a serve message. Only the fields this file reads are named; the rest ride through. */
interface ContentPart {
  type: string;
  text?: string;
}

interface RunningMessage {
  id: string;
  createdAt: number;
  /**
   * The serve's own record for this message, kept WHOLE, or null before a read has drawn it.
   *
   * Whole because the deltas name none of it: the tool parts with their state and their output,
   * the tokens, the cost. A row built from the stream alone would drop the shell call a reader is
   * watching run, which is the same class of loss as dropping the thinking.
   */
  durable: SessionMessage | null;
  /** `<kind>:<ordinal>` to the part, in the order the serve opened them. */
  byKey: Map<string, StreamedPart>;
}

/**
 * A message's parts named the way the serve names them: by position among parts of their own kind,
 * which is all a delta carries. `key` is null for a part that is not text or reasoning, which is
 * every part the deltas never speak for.
 *
 * One place, because a delta finds its part by this key, the durable merge lines the two records
 * up by it, and the row is built from it. If they disagreed, a merge would write a part into the
 * row under a key the next delta does not read, and the text that followed would land in a second
 * block.
 */
function* namedParts(
  message: SessionMessage | null,
): Generator<{ part: ContentPart; key: string | null }> {
  const counts = new Map<string, number>();
  for (const part of (message as { content?: ContentPart[] } | null)?.content ?? []) {
    if (part.type !== "text" && part.type !== "reasoning") {
      yield { part, key: null };
      continue;
    }
    const ordinal = counts.get(part.type) ?? 0;
    counts.set(part.type, ordinal + 1);
    yield { part, key: `${part.type}:${ordinal}` };
  }
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
  const byKey = new Map<string, StreamedPart>();
  for (const { part, key } of namedParts(durable)) {
    if (key === null) continue;
    byKey.set(key, { type: part.type as OpencodeStreamedKind, text: part.text ?? "" });
  }
  return {
    id: durable.id,
    createdAt: (durable as { time: { created: number } }).time.created,
    durable,
    byKey,
  };
}

/**
 * The read to draw, with the stream's record of the message the serve is still writing put in
 * place of the read's own.
 *
 * Substitution rather than a second draw, because two draws publishes the thinner row first and
 * corrects it a millisecond later, and a reader is entitled to a row that only ever grows. The read
 * still supplies the page around it, so every other message, the tokens and the tool parts are the
 * serve's own.
 */
export function mergedRead(
  read: readonly SessionMessage[],
  streamed: SessionMessage,
): SessionMessage[] {
  const drawn = read.map((message) => (message.id === streamed.id ? streamed : message));
  return drawn.some((message) => message.id === streamed.id) ? drawn : [...drawn, streamed];
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
      message.byKey.set(key, { type: part.kind, text: "" });
      return null;
    }
    if (part.phase === "delta" && part.chunk) streamed.text += part.chunk;
    // The serve's own closing text wins where it has one: it is the whole part rather than an
    // accumulation, so it is the authority on anything the deltas dropped or reordered. It is
    // also empty on an encrypted-thinking provider, which is why this is not an assignment.
    if (part.phase === "ended" && part.text) streamed.text = part.text;
    return this.materialise(message);
  }

  /**
   * The row to draw: the serve's own record, with the streamed words in place of its own.
   *
   * The durable message's parts in its own order, because that is the order the settled row will
   * have and a reader should not see the blocks move as the two records disagree. Its text parts
   * take the stream's words rather than the read's: `mergeDurable` has already reconciled the two,
   * and it has to be the one that does, because the stream is the accumulation the deltas append to
   * and a read's text can only become its base. Parts the serve has not written yet are appended in
   * the order the stream opened them.
   *
   * Null when no part holds any words, which is the same honesty the deltas keep: a part that has
   * just opened draws nothing, and an encrypted-thinking part draws nothing until a read brings
   * the row that says it exists.
   */
  private materialise(message: RunningMessage): SessionMessage | null {
    const content: unknown[] = [];
    const emitted = new Set<string>();
    for (const { part, key } of namedParts(message.durable)) {
      if (key === null) {
        content.push(part);
        continue;
      }
      emitted.add(key);
      const streamed = message.byKey.get(key);
      if (!streamed) {
        throw new Error(`opencode stream tail: the read names part ${key} of ${message.id} that the stream never opened`);
      }
      content.push({ type: part.type, text: streamed.text });
    }
    for (const [key, part] of message.byKey) {
      if (!emitted.has(key)) content.push({ type: part.type, text: part.text });
    }
    if (!content.some((part) => typeof (part as ContentPart).text === "string" && (part as ContentPart).text)) {
      return null;
    }
    // Shaped like the durable message and nothing more, because that is all the mapper reads: `id`
    // and `type` to pick the branch and the row, `time.created` to order it, `content` for the
    // blocks. The parts are copied so a row the mapper is holding cannot change under it on the
    // next delta, and the serve's own fields ride through the spread -- which is how a tool part
    // the deltas never named survives into a row drawn because one more sentence arrived. There is
    // no `time.completed` added here; see the file header for why a streamed message never closes
    // itself.
    const base = (message.durable ?? {}) as { time?: { created?: number } };
    return {
      ...(message.durable as object),
      id: message.id,
      type: "assistant",
      time: { ...base.time, created: message.createdAt },
      content,
    } as unknown as SessionMessage;
  }

  /**
   * Folds a durable read into what is being streamed, rather than obeying it, and hands back the
   * row the read should have drawn.
   *
   * The serve inserts a message into its history while the step is still writing it, so a read
   * that names the running message is not a record OF it -- it is a snapshot of a row mid-write,
   * and the snapshot is regularly behind the words already on screen. Mapping that snapshot as the
   * answer is what made a running turn lose its thinking: the row was replaced by one holding
   * `reasoning: ""` and the shell part the read had, so the thinking vanished the moment a tool
   * call bought a read, and came back on the next one. Measured on a live turn, with the serve's
   * own message read `reasoning: 0` while the stream held 583 characters.
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
   *   the tail holds is then the better record and is kept.
   *
   * In every case the message returned is the merge, and the caller draws it. Returning it is the
   * point rather than a convenience: a repair the next delta would eventually reveal is a repair
   * the reader watched the row go without, which is the whole of what was wrong.
   */
  settle(sessionId: string, read: readonly SessionMessage[]): SessionMessage | null {
    const running = this.running.get(sessionId);
    const held = running ? read.find((message) => message.id === running.id) : undefined;
    if (running && held && isFinished(held)) {
      this.running.delete(sessionId);
      return null;
    }
    const unfinished = newestUnfinishedAssistant(read);
    if (!unfinished) return running ? this.materialise(running) : null;
    if (running && running.id === unfinished.id) {
      this.mergeDurable(running, unfinished);
      return this.materialise(running);
    }
    // Either nothing was held, or the serve has opened a newer step than the one we hold: the
    // durable record for the one being written now is the better place to start.
    const seeded = seededFrom(unfinished);
    this.running.set(sessionId, seeded);
    this.trim();
    return this.materialise(seeded);
  }

  /**
   * Takes the read's record for a running message, and lines its text parts up with the stream's.
   *
   * The whole durable message is kept, so a tool part, a token count and a cost the deltas never
   * named are still there to be drawn. A text part the stream has not opened is added under the key
   * a delta for it would use, and a part the read has more words for becomes the stream's base
   * rather than a separate copy: the deltas keep appending to one accumulation per part, so a
   * sentence arriving after a read that had caught up extends what the reader can see instead of
   * being dropped in favour of the read's text.
   *
   * The creation time comes across too, so the row is ordered by the serve's own clock from the
   * first delta rather than moving when the first read lands.
   */
  private mergeDurable(running: RunningMessage, durable: SessionMessage): void {
    running.durable = durable;
    running.createdAt = (durable as { time: { created: number } }).time.created;
    for (const { part, key } of namedParts(durable)) {
      if (key === null) continue;
      const durableText = part.text ?? "";
      const streamed = running.byKey.get(key);
      if (!streamed) {
        running.byKey.set(key, { type: part.type as OpencodeStreamedKind, text: durableText });
      } else if (durableText.length > streamed.text.length) {
        streamed.text = durableText;
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
      durable: null,
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
