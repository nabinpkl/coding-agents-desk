// Which sessions the harness is compacting right now, and what the summariser has written so far.
//
// Its own module because it is the one piece of a captured flow that is kept OUTSIDE the session's
// projection. A compaction's summariser is not the session speaking, so none of it is bound to the
// thread: streamed in as a live row, it landed for minutes on top of the one row that says the
// context was reset. But the summary is what a reader is waiting on while it happens, so its text is
// held here, beside the thread, for a surface to draw under the notice that says what is going on.
//
// It exists because the silence is otherwise unreadable. A compaction writes nothing to the
// transcript until it lands, and takes two to four minutes on a large context. A reader watching the
// feed sees a session that has stopped, which is what a finished turn also looks like.

import { mapAnthropicStreamEvent } from "@/live/claudeNetworkSource";

/**
 * How long a compaction is believed to be running without an end event.
 *
 * Generous rather than tight. The longest measured here took 2m34s on a 295k-token context, and
 * the two ways of being wrong are not symmetric: too long leaves a notice up after the work is
 * done, too short takes it down while the work is still happening and tells the reader the silence
 * means something else.
 *
 * A timer is needed at all because the end event is not guaranteed. The observer subscription can
 * drop mid-stream and reconnect, and every flow that was open across that gap ends without anyone
 * being told.
 */
const COMPACTION_MAX_MS = 15 * 60_000;

/**
 * How many finished flows are remembered, so one cannot be started again.
 *
 * The observer announces each flow TWICE -- measured 2026-09-14, every completed flow in a 75s
 * window came as two `flowUpserted` events and one `streamEnded`, with the second announcement
 * arriving alongside the end. The mirror's own guard against the repeat is that the flow's context
 * is still in hand, but a compaction's context is dropped seconds after it is recognised while the
 * compaction itself runs for minutes. So the second announcement re-fetched the body, recognised
 * the same compaction, and started it again AFTER its end had been and gone: the notice latched on
 * and only the timer took it down.
 *
 * A few hundred is far more than the two or three flows in play at once, and a Map keeps insertion
 * order so the oldest is the one evicted.
 */
const REMEMBERED_FLOWS = 256;

type CompactionListener = (sessionId: string, active: boolean) => void;
/** `replace` says `text` is the whole summary so far, rather than more of it. */
type SummaryListener = (sessionId: string, text: string, replace: boolean) => void;

interface RunningCompaction {
  readonly sessionId: string;
  summary: string;
}

export class CompactionWatch {
  private readonly flows = new Map<string, RunningCompaction>();
  private readonly finished = new Map<string, true>();
  private readonly listeners = new Set<CompactionListener>();
  private readonly summaryListeners = new Set<SummaryListener>();

  constructor(private readonly maxMs: number = COMPACTION_MAX_MS) {}

  isCompacting(sessionId: string): boolean {
    return this.latest(sessionId) !== undefined;
  }

  /**
   * What the session's summariser has written so far, or null when the session is not compacting.
   *
   * The NEWEST summariser's, when there is more than one: two flows compacting one session is a
   * retry, and the retry's summary is the one that lands.
   */
  summary(sessionId: string): string | null {
    return this.latest(sessionId)?.summary ?? null;
  }

  /** Listeners hear a session's FIRST start and its LAST end, not one event per flow. */
  onChange(listener: CompactionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Listeners hear the summary of `summary(sessionId)` grow, or be replaced by another flow's. */
  onSummary(listener: SummaryListener): () => void {
    this.summaryListeners.add(listener);
    return () => {
      this.summaryListeners.delete(listener);
    };
  }

  /**
   * `buffered` is what the flow streamed before it could be recognised. A summariser starts
   * writing at once, and reading its request body back takes longer than its first deltas do.
   */
  begin(flowId: string, sessionId: string, buffered: readonly string[] = []): void {
    if (this.flows.has(flowId) || this.finished.has(flowId)) return;
    const already = this.isCompacting(sessionId);
    const running: RunningCompaction = { sessionId, summary: buffered.map(summaryText).join("") };
    this.flows.set(flowId, running);
    const timer = setTimeout(() => this.end(flowId), this.maxMs);
    timer.unref?.();
    if (!already) this.announce(sessionId, true);
    // Replaced rather than appended even when empty, when another flow's text is on screen: a
    // retry's summary starts from nothing.
    if (already || running.summary) this.announceSummary(sessionId, running.summary, true);
  }

  /** Adds one captured delta to a running compaction's summary. False when the flow is not one. */
  append(flowId: string, payload: string): boolean {
    const running = this.flows.get(flowId);
    if (!running) return false;
    const text = summaryText(payload);
    if (!text) return true;
    running.summary += text;
    if (this.latest(running.sessionId) === running) {
      this.announceSummary(running.sessionId, text, false);
    }
    return true;
  }

  end(flowId: string): void {
    this.remember(flowId);
    const running = this.flows.get(flowId);
    if (running === undefined) return;
    const wasLatest = this.latest(running.sessionId) === running;
    this.flows.delete(flowId);
    const next = this.latest(running.sessionId);
    if (next === undefined) this.announce(running.sessionId, false);
    else if (wasLatest) this.announceSummary(running.sessionId, next.summary, true);
  }

  private latest(sessionId: string): RunningCompaction | undefined {
    let found: RunningCompaction | undefined;
    for (const running of this.flows.values()) {
      if (running.sessionId === sessionId) found = running;
    }
    return found;
  }

  /** Marked ended whether or not it had started: the end can arrive first. */
  private remember(flowId: string): void {
    this.finished.delete(flowId);
    this.finished.set(flowId, true);
    while (this.finished.size > REMEMBERED_FLOWS) {
      const oldest = this.finished.keys().next();
      if (oldest.done) break;
      this.finished.delete(oldest.value);
    }
  }

  private announce(sessionId: string, active: boolean): void {
    for (const listener of this.listeners) listener(sessionId, active);
  }

  private announceSummary(sessionId: string, text: string, replace: boolean): void {
    for (const listener of this.summaryListeners) listener(sessionId, text, replace);
  }
}

/**
 * The prose one captured delta adds to a summary.
 *
 * Text only. A summariser that thinks first streams its thinking as well, and that is not the
 * summary a reader is waiting on. An unreadable payload adds nothing, the way it does in the mirror.
 */
function summaryText(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "";
  }
  const event = mapAnthropicStreamEvent(parsed);
  if (event?.kind !== "content_block_delta" || event.delta.type !== "text_delta") return "";
  return typeof event.delta.text === "string" ? event.delta.text : "";
}
