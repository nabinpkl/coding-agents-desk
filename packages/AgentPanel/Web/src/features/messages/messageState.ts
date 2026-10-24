// The vocabulary a message thread reads in: what state a thread is in, and how old it is.
//
// The delivery states as the owner reads them, as one idea here rather than one per row that
// shows them, and the local time a message row prints.

import type { Message } from "@agentdesk/agent-feed-wire";

/**
 * What one message's own state means, in the owner's terms.
 *
 * A state, not a status line: "delivered" on a message that has been answered for an hour says
 * nothing true about the thread, which is why `threadState` below is the thing a row shows.
 */
export const MESSAGE_STATE: Record<Message["state"], string> = {
  queued: "waiting for a live session",
  pushed: "sending",
  delivered: "delivered",
  answered: "answered",
  expired: "expired",
  cancelled: "cancelled",
};

/** A thread's state, which is the last thing that happened to it rather than the last message. */
export type ThreadState = "waiting" | "needs-you" | "open" | "done" | "closed";

/**
 * The thread's state, from the last message that owes something.
 *
 * The bug this replaces: reading the last message's state. A thread ends on the agent's reply,
 * which is `delivered` to the owner, so every finished thread announced itself as "delivered" and
 * a thread waiting on a live session looked the same as one that had just been answered.
 */
export function threadState(thread: Message[]): ThreadState {
  const last = thread[thread.length - 1];
  if (!last) return "open";
  if (last.state === "queued") return "waiting";
  if (last.state === "expired" || last.state === "cancelled") return "closed";
  // An agent's request or question that has not been replied to is what is owed to the owner.
  const owed = (last.kind === "request" || last.kind === "question") && last.from !== "human";
  if (owed && (last.state === "delivered" || last.state === "pushed")) return "needs-you";
  return "done";
}

const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  waiting: "waiting for a live session",
  "needs-you": "needs a reply",
  open: "open",
  done: "done",
  closed: "closed",
};

export function threadStateLabel(state: ThreadState): string {
  return THREAD_STATE_LABEL[state];
}

/** The only two states that mean the thread is still owed something. */
export function isUnanswered(thread: Message[]): boolean {
  return threadState(thread) === "needs-you";
}

/** Can the owner still give up on this thread? Only while it is queued for nobody. */
export function isCancellable(thread: Message[]): boolean {
  return threadState(thread) === "waiting";
}

/** Local time, hours and minutes. */
export function messageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
