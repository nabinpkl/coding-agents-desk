// Which opencode sessions are compacting right now, and what the summariser has written so far.
//
// The serve's own shape, mirroring `claudeCompactionWatch` for the proxy-observed Claude flows:
// a compaction writes no durable row worth drawing until it lands, so a feed that only re-reads
// messages sits silent for the minutes the summariser streams. The serve publishes that
// streaming instead as compaction started / delta / ended events, and this watch folds those
// into the same beside-the-thread summary the timeline already draws for Claude (`compacting`
// plus `compaction-summary`), so one notice covers both harnesses.
//
// Two event families name the same streaming, from the two serve generations this sidecar has
// talked to: v1's `session.next.compaction.*` carries the compaction's own message id on every
// event, while v2's `session.compaction.*` names only the session on deltas (the started event's
// `inputID` is the only key, and it is optional). Deltas that name no key append to the
// session's newest flow, which is the retry's -- the one that lands.
//
// Keyed by the compaction's own message id rather than a flow id: a retry compacts the same
// session under a new message, and the retry's summary is the one that lands.
type CompactionListener = (sessionId: string, active: boolean) => void;
/** `replace` says `text` is the whole summary so far, rather than more of it. */
type SummaryListener = (sessionId: string, text: string, replace: boolean) => void;

interface RunningCompaction {
  readonly sessionId: string;
  summary: string;
}

/**
 * How long a compaction is believed to be running without an end event.
 *
 * The same backstop Claude's watch keeps, for the same reason: the event stream can drop
 * mid-compaction and reconnect, and a flow open across that gap ends without anyone being
 * told. Too long leaves a notice up after the work is done, too short takes it down while
 * the summary is still streaming.
 */
const COMPACTION_MAX_MS = 15 * 60_000;

export class OpencodeCompactionWatch {
  private readonly flows = new Map<string, RunningCompaction>();
  private readonly listeners = new Set<CompactionListener>();
  private readonly summaryListeners = new Set<SummaryListener>();

  constructor(private readonly maxMs: number = COMPACTION_MAX_MS) {}

  isCompacting(sessionId: string): boolean {
    return this.latest(sessionId) !== undefined;
  }

  /**
   * What the session's summariser has written so far, or null when the session is not compacting.
   *
   * The NEWEST summariser's, when there is more than one: two compactions on one session is a
   * retry, and the retry's summary is the one that lands.
   */
  summary(sessionId: string): string | null {
    return this.latest(sessionId)?.summary ?? null;
  }

  /** Listeners hear a session's FIRST start and its LAST end, not one event per compaction. */
  onChange(listener: CompactionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Listeners hear the summary of `summary(sessionId)` grow, or be replaced by another compaction's. */
  onSummary(listener: SummaryListener): () => void {
    this.summaryListeners.add(listener);
    return () => {
      this.summaryListeners.delete(listener);
    };
  }

  begin(messageId: string, sessionId: string): void {
    if (this.flows.has(messageId)) return;
    const already = this.isCompacting(sessionId);
    this.flows.set(messageId, { sessionId, summary: "" });
    const timer = setTimeout(() => this.end(messageId), this.maxMs);
    timer.unref?.();
    if (!already) this.announce(sessionId, true);
  }

  /** Adds one streamed delta to a running compaction's summary. False when it is not one. */
  append(messageId: string, text: string): boolean {
    const running = this.flows.get(messageId);
    if (!running) return false;
    if (!text) return true;
    running.summary += text;
    if (this.latest(running.sessionId) === running) {
      this.announceSummary(running.sessionId, text, false);
    }
    return true;
  }

  /**
   * Adds one streamed delta to the session's newest compaction, for events that name the
   * session but not the compaction (v2 deltas carry only `sessionID` plus text). False when
   * nothing is running there, which drops the delta rather than raising a notice for it.
   */
  appendToSession(sessionId: string, text: string): boolean {
    const running = this.latest(sessionId);
    if (!running) return false;
    if (!text) return true;
    running.summary += text;
    this.announceSummary(sessionId, text, false);
    return true;
  }

  end(messageId: string): void {
    const running = this.flows.get(messageId);
    if (running === undefined) return;
    const wasLatest = this.latest(running.sessionId) === running;
    this.flows.delete(messageId);
    const next = this.latest(running.sessionId);
    if (next === undefined) this.announce(running.sessionId, false);
    else if (wasLatest) this.announceSummary(running.sessionId, next.summary, true);
  }

  /**
   * Ends every compaction running on a session, for an event that names the session but not
   * the compaction (`session.compacted`). A dropped stream can orphan the notice past its end;
   * the landed checkpoint is the proof the work is over.
   */
  endSession(sessionId: string): void {
    const ids = [...this.flows]
      .filter(([, running]) => running.sessionId === sessionId)
      .map(([messageId]) => messageId);
    for (const messageId of ids) this.end(messageId);
  }

  private latest(sessionId: string): RunningCompaction | undefined {
    let found: RunningCompaction | undefined;
    for (const running of this.flows.values()) {
      if (running.sessionId === sessionId) found = running;
    }
    return found;
  }

  private announce(sessionId: string, active: boolean): void {
    for (const listener of this.listeners) listener(sessionId, active);
  }

  private announceSummary(sessionId: string, text: string, replace: boolean): void {
    for (const listener of this.summaryListeners) listener(sessionId, text, replace);
  }
}
