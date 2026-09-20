// Which sessions the harness is compacting right now.
//
// Its own module because it is the one piece of a captured flow that OUTLIVES the flow. The live
// mirror drops a compaction's summariser stream seconds after recognising it -- nothing of it is
// the session speaking, so none of it is mirrored -- while the compaction itself runs for minutes.
// So this holds no projection, no deltas and no message: one flow id, the session it is compacting,
// and a way to be told when that changes.
//
// It exists because the silence is otherwise unreadable. A compaction writes nothing to the
// transcript until it lands, streams nothing into the thread, and takes two to four minutes on a
// large context. A reader watching the feed sees a session that has stopped, which is what a
// finished turn also looks like.

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

export class CompactionWatch {
  private readonly flows = new Map<string, string>();
  private readonly finished = new Map<string, true>();
  private readonly listeners = new Set<CompactionListener>();

  constructor(private readonly maxMs: number = COMPACTION_MAX_MS) {}

  isCompacting(sessionId: string): boolean {
    for (const owner of this.flows.values()) {
      if (owner === sessionId) return true;
    }
    return false;
  }

  /** Listeners hear a session's FIRST start and its LAST end, not one event per flow. */
  onChange(listener: CompactionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  begin(flowId: string, sessionId: string): void {
    if (this.flows.has(flowId) || this.finished.has(flowId)) return;
    const already = this.isCompacting(sessionId);
    this.flows.set(flowId, sessionId);
    const timer = setTimeout(() => this.end(flowId), this.maxMs);
    timer.unref?.();
    if (!already) this.announce(sessionId, true);
  }

  end(flowId: string): void {
    this.remember(flowId);
    const sessionId = this.flows.get(flowId);
    if (sessionId === undefined) return;
    this.flows.delete(flowId);
    if (!this.isCompacting(sessionId)) this.announce(sessionId, false);
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
}
