// The ask_owner calls waiting on the owner, held in memory, and who is watching them.
//
// In memory on purpose. A call waits inside a live tool call, so it can outlive neither the
// session nor the process serving the tool, and both of those hold a request open here while it
// waits. A call is waiting exactly while some such request is: when the last one goes, its session
// ended or its tool call was cancelled, and there is nothing left to hand an answer to. A sidecar
// that restarts loses the list, and each serving process sends its call again, under the same id.
//
// Keyed by the tool call's own id, which is also the transcript's tool_use id.

import type {
  AskOwnerCall,
  AskOwnerOutcome,
  AskOwnerVerdict,
  SourceId,
  WaitAskOwnerCommand,
} from "@agentdesk/agent-feed-wire";
import { readAnswers } from "@/asks/askOwnerShape";

interface Waiting {
  call: AskOwnerCall;
  /** Each request holding this call open, told how it ended. */
  waiters: Set<(verdict: AskOwnerVerdict) => void>;
}

const sessionKey = (source: SourceId, sessionId: string) => `${source}:${sessionId}`;

export class AskOwnerWaits {
  private readonly waiting = new Map<string, Waiting>();
  private readonly watchers = new Map<string, Set<(asks: AskOwnerCall[]) => void>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Holds a call open until it is answered or dismissed, telling `onVerdict` how it ended. Returns
   * the release for a request that went away first; the call stops waiting with its last request.
   *
   * The same id sent again joins the call already waiting rather than replacing it, so a serving
   * process that reconnects keeps the question the owner may be halfway through answering.
   *
   * So does a new call asking exactly what one of its session's calls is already asking. A model
   * told its call "moved to the background" can take that for a failure and ask again, and would
   * then do so every two minutes; joined, the owner sees one card, and one answer ends both.
   */
  wait(command: WaitAskOwnerCommand, onVerdict: (verdict: AskOwnerVerdict) => void): () => void {
    let entry = this.waiting.get(command.toolUseId) ?? this.askingTheSame(command);
    if (!entry) {
      entry = { call: { ...command, askedAt: this.now() }, waiters: new Set() };
      this.waiting.set(command.toolUseId, entry);
      this.publish(entry.call.source, entry.call.sessionId);
    }
    const held = entry;
    held.waiters.add(onVerdict);
    return () => {
      if (!held.waiters.delete(onVerdict) || held.waiters.size > 0) return;
      if (this.waiting.get(held.call.toolUseId) !== held) return;
      this.waiting.delete(held.call.toolUseId);
      this.publish(held.call.source, held.call.sessionId);
    };
  }

  /** Hands the owner's answers to the waiting call, once they fit its questions. */
  answer(source: SourceId, sessionId: string, toolUseId: string, raw: unknown): AskOwnerOutcome {
    const entry = this.find(source, sessionId, toolUseId);
    if (!entry) return notWaiting();
    const answers = readAnswers(raw, entry.call);
    if (!answers.ok) return { delivered: false, reason: "wrong-answers", message: answers.message };
    return this.settle(entry, { answered: answers.value });
  }

  /** Ends the waiting call without an answer. */
  dismiss(source: SourceId, sessionId: string, toolUseId: string): AskOwnerOutcome {
    const entry = this.find(source, sessionId, toolUseId);
    return entry ? this.settle(entry, { dismissed: true }) : notWaiting();
  }

  /** Every call this session is waiting on, oldest first, now and on every change. */
  observe(source: SourceId, sessionId: string, onAsks: (asks: AskOwnerCall[]) => void): () => void {
    const key = sessionKey(source, sessionId);
    const watching = this.watchers.get(key) ?? new Set();
    this.watchers.set(key, watching);
    watching.add(onAsks);
    onAsks(this.callsOf(source, sessionId));
    return () => {
      watching.delete(onAsks);
      if (watching.size === 0) this.watchers.delete(key);
    };
  }

  private askingTheSame(command: WaitAskOwnerCommand): Waiting | undefined {
    const asked = JSON.stringify(command.questions);
    return [...this.waiting.values()].find(
      ({ call }) =>
        call.source === command.source &&
        call.sessionId === command.sessionId &&
        JSON.stringify(call.questions) === asked,
    );
  }

  private find(source: SourceId, sessionId: string, toolUseId: string): Waiting | undefined {
    const entry = this.waiting.get(toolUseId);
    // By session too, so one session's card cannot answer another session's question.
    return entry && entry.call.source === source && entry.call.sessionId === sessionId ? entry : undefined;
  }

  private settle(entry: Waiting, verdict: AskOwnerVerdict): AskOwnerOutcome {
    this.waiting.delete(entry.call.toolUseId);
    for (const tell of entry.waiters) tell(verdict);
    this.publish(entry.call.source, entry.call.sessionId);
    return { delivered: true };
  }

  private callsOf(source: SourceId, sessionId: string): AskOwnerCall[] {
    return [...this.waiting.values()]
      .map((entry) => entry.call)
      .filter((call) => call.source === source && call.sessionId === sessionId)
      .sort((a, b) => a.askedAt - b.askedAt);
  }

  private publish(source: SourceId, sessionId: string): void {
    const watching = this.watchers.get(sessionKey(source, sessionId));
    if (!watching) return;
    const asks = this.callsOf(source, sessionId);
    for (const tell of watching) tell(asks);
  }
}

function notWaiting(): AskOwnerOutcome {
  return {
    delivered: false,
    reason: "not-waiting",
    message: "this question is no longer waiting: it was answered, closed, or its session ended",
  };
}
