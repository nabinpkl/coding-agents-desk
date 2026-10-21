// The blocks a session writes about its own turn, read out of a reply so the feed can draw them
// as what they are rather than as prose.
//
// The taste posture asks a session for three: a `<task-state>` block opening a response (the goal
// and its decisions), a `<spoken-status>` block near the end (how the turn stands, for someone
// listening), and a `<next-suggestions-for-user>` block closing it (numbered next steps). As
// Markdown they rendered as one run-together paragraph, because the sanitizer drops the unknown tag
// and keeps its text. Here a reply is cut into prose and those blocks, in the order written.
//
// Lenient where the sidecar is strict (`agent-feed/sidecar/src/transcripts/spokenStatus.ts` counts
// only a block that closes the reply), because this decides how text LOOKS, not what the session
// reports: a block anywhere in the reply is drawn as a block. Two limits keep prose prose: the tag
// must start its line, and a block inside a code fence stays code, so a reply showing the format
// still shows it as written. A block still being written (no closing tag yet) is drawn with what
// has arrived.

import type { SessionSummary } from "@agentdesk/agent-feed-wire";

type SpokenStatus = NonNullable<SessionSummary["spokenStatus"]>;
export type SpokenKind = SpokenStatus["lines"][number]["kind"];

/** Most pressing first: a chip naming one kind names the first of these a status holds. */
export const SPOKEN_KIND_ORDER: readonly SpokenKind[] = ["waiting", "failed", "running", "done", "note"];
export const SPOKEN_KIND_LABEL: Record<SpokenKind, string> = {
  waiting: "Needs you",
  failed: "Failed",
  running: "Running",
  done: "Done",
  note: "Note",
};
/** Ink for each kind's label: the two that ask something of the reader stand out. */
export const SPOKEN_KIND_INK: Record<SpokenKind, string> = {
  waiting: "text-attention font-medium",
  failed: "text-destructive font-medium",
  running: "text-foreground",
  done: "session-muted-ink",
  note: "session-muted-ink",
};

export type ReplySegment =
  | { kind: "prose"; text: string }
  | { kind: "task"; task: string; decisions: string[] }
  | { kind: "status"; lines: { kind: SpokenKind; text: string }[] }
  | { kind: "suggestions"; items: string[] };

const TAGS = {
  "task-state": "task",
  "spoken-status": "status",
  "next-suggestions-for-user": "suggestions",
} as const;
type TagName = keyof typeof TAGS;

const OPENING = /^\s*<(task-state|spoken-status|next-suggestions-for-user)>(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const KINDS: readonly SpokenKind[] = ["waiting", "failed", "done", "running", "note"];

function task(body: string[]): ReplySegment {
  let goal = "";
  const decisions: string[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (!line) continue;
    if (!goal && /^task\s*:/i.test(line)) goal = line.replace(/^task\s*:\s*/i, "");
    else decisions.push(line.replace(/^[-*]\s+/, ""));
  }
  return { kind: "task", task: goal, decisions };
}

function status(body: string[]): ReplySegment {
  const lines: { kind: SpokenKind; text: string }[] = [];
  for (const raw of body) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line) continue;
    const match = /^([a-z]+)\s*:\s*(.+)$/i.exec(line);
    const named = KINDS.find((kind) => kind === match?.[1]?.toLowerCase());
    lines.push(named ? { kind: named, text: match?.[2] ?? "" } : { kind: "note", text: line });
  }
  return { kind: "status", lines };
}

function suggestions(body: string[]): ReplySegment {
  const items: string[] = [];
  let current: string | null = null;
  for (const raw of body) {
    const line = raw.trim();
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (current !== null) items.push(current);
      current = numbered[1] ?? "";
    } else if (!line) {
      // A blank line ends an entry; the posture puts one between each.
      if (current !== null) items.push(current);
      current = null;
    } else current = current === null ? line : `${current} ${line}`;
  }
  if (current !== null) items.push(current);
  return { kind: "suggestions", items: items.filter(Boolean) };
}

function report(name: TagName, body: string[]): ReplySegment {
  const kind = TAGS[name];
  if (kind === "task") return task(body);
  if (kind === "status") return status(body);
  return suggestions(body);
}

/** `text` as prose and report blocks, in the order written. Prose that is only whitespace is left out. */
export function splitReply(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const joined = prose.join("\n");
    if (joined.trim()) segments.push({ kind: "prose", text: joined });
    prose = [];
  };

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      prose.push(line);
      continue;
    }
    const fenceOpens = FENCE.exec(line);
    if (fenceOpens) {
      fence = fenceOpens[1] ?? null;
      prose.push(line);
      continue;
    }
    const opens = OPENING.exec(line);
    if (!opens) {
      prose.push(line);
      continue;
    }
    const name = opens[1] as TagName;
    const close = `</${name}>`;
    const body: string[] = [];
    let after = "";
    let rest = opens[2] ?? "";
    // Read to the closing tag, which may share the opening line, or to the end of a reply still
    // being written.
    for (;;) {
      const ends = rest.indexOf(close);
      if (ends !== -1) {
        body.push(rest.slice(0, ends));
        after = rest.slice(ends + close.length);
        break;
      }
      body.push(rest);
      at += 1;
      if (at >= lines.length) break;
      rest = lines[at] ?? "";
    }
    flush();
    segments.push(report(name, body));
    if (after.trim()) prose.push(after);
  }
  flush();
  return segments;
}
