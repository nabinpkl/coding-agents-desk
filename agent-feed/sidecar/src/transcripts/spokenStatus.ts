// Reading a `<spoken-status>` block out of what a session wrote, and saying a session's pending
// question the same way.
//
// The taste posture asks a session to close a turn with one, just above its next suggestions: up to
// four short lines, each opening with its kind, written to be heard by someone who is listening
// while doing something else (`push/sessionSpeech.ts` says them; a card shows them).
//
// Only a block that CLOSES the text counts: after it, nothing but the next-suggestions block. The
// posture puts it last, so a block quoted earlier -- an agent explaining the format, a plan showing
// an example -- is not this session's status. Callers add the other half: only the session's own
// assistant text, never a person's message or a tool result.

import type { SessionSummary } from "@agentdesk/agent-feed-wire";

export type SessionSpokenStatus = NonNullable<SessionSummary["spokenStatus"]>;
export type SpokenStatusKind = SessionSpokenStatus["lines"][number]["kind"];

const OPEN = "<spoken-status>";
const CLOSE = "</spoken-status>";
const SUGGESTIONS = /^<next-suggestions-for-user>[\s\S]*<\/next-suggestions-for-user>$/;
const KINDS: readonly SpokenStatusKind[] = ["waiting", "failed", "done", "running", "note"];
/** The posture's own limits, with room, so a block that overran them still shows cut short. */
const MAX_LINES = 4;
const MAX_LINE_CHARACTERS = 160;

/** Cheap enough to run on every transcript line before any of it is parsed. */
export function mayHoldSpokenStatus(text: string): boolean {
  return text.includes(OPEN);
}

/** The block a text closes with, or null when it closes with none or the block says nothing. */
export function parseSpokenStatus(text: string, at: number): SessionSpokenStatus | null {
  const start = text.lastIndexOf(OPEN);
  if (start === -1) return null;
  const end = text.indexOf(CLOSE, start);
  if (end === -1) return null;
  const after = text.slice(end + CLOSE.length).trim();
  if (after && !SUGGESTIONS.test(after)) return null;
  const lines: SessionSpokenStatus["lines"] = [];
  for (const raw of text.slice(start + OPEN.length, end).split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line || lines.length === MAX_LINES) continue;
    const match = /^([a-z]+)\s*:\s*(.+)$/i.exec(line);
    const named = KINDS.find((kind) => kind === match?.[1]?.toLowerCase());
    // A line with no kind the posture names is still said, as a note, rather than dropped.
    lines.push({ kind: named ?? "note", text: cut(named ? (match?.[2] ?? "") : line) });
  }
  return lines.length > 0 ? { lines, at, from: "block" } : null;
}

/** A question the session asked the person and waits on, as a status of one `waiting` line. */
export function questionStatus(questions: readonly string[], at: number): SessionSpokenStatus | null {
  const asked = questions.map((question) => question.replace(/\s+/g, " ").trim()).filter(Boolean);
  const first = asked[0];
  if (!first) return null;
  const more = asked.length - 1;
  const text = more > 0 ? `${first} (and ${more} more ${more === 1 ? "question" : "questions"})` : first;
  return { lines: [{ kind: "waiting", text: cut(text) }], at, from: "question" };
}

function cut(value: string): string {
  return value.length <= MAX_LINE_CHARACTERS ? value : `${value.slice(0, MAX_LINE_CHARACTERS - 1)}…`;
}
