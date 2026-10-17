// Reading a `<task-state>` block out of what a session wrote.
//
// The taste posture asks a session to open a response with one when it starts work the person
// handed over: a goal, then at most four one-line decisions. It is the session's own report of
// what it took the request to be, so reading it costs nothing and asks nothing -- no tool, no
// prompt, no rename, and so nothing here can start a turn.
//
// Only a text that OPENS with the tag counts. The posture puts the block first, so a block quoted
// further into a message -- an agent explaining the format, a reply repeating a peer's -- is not
// this session's. Callers add the other half: only the session's own assistant text, never a
// person's message or a tool result.

import type { SessionSummary } from "@agentdesk/agent-feed-wire";

export type SessionTaskState = NonNullable<SessionSummary["taskState"]>;

const OPEN = "<task-state>";
const CLOSE = "</task-state>";
/** The posture's own limits, with room, so a block that overran them still shows cut short. */
const MAX_TASK_CHARACTERS = 80;
const MAX_LINE_CHARACTERS = 120;
const MAX_LINES = 4;

/** Cheap enough to run on every transcript line before any of it is parsed. */
export function mayHoldTaskState(text: string): boolean {
  return text.includes(OPEN);
}

/** The block a text opens with, or null when it opens with none or the block names no task. */
export function parseTaskState(text: string, at: number): SessionTaskState | null {
  const body = text.trimStart();
  if (!body.startsWith(OPEN)) return null;
  const end = body.indexOf(CLOSE);
  if (end === -1) return null;
  let task: string | undefined;
  const lines: string[] = [];
  for (const raw of body.slice(OPEN.length, end).split("\n")) {
    const line = raw.trim();
    if (task === undefined && line.toLowerCase().startsWith("task:")) {
      task = cut(line.slice("task:".length).trim(), MAX_TASK_CHARACTERS);
    } else if (line.startsWith("- ") && lines.length < MAX_LINES) {
      const decision = cut(line.slice(2).trim(), MAX_LINE_CHARACTERS);
      if (decision) lines.push(decision);
    }
  }
  return task ? { task, lines, at } : null;
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
