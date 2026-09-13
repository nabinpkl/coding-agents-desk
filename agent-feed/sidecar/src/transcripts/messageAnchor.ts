/**
 * Turning "this row in the panel" into "this many messages back, and it says this".
 *
 * The panel addresses a transcript line by the id the event index gave it,
 * `claude:<sessionId>:line:<rawIndex>`. The rewind picker addresses a message by how far back from
 * the newest it is, and proves it by what the row says. Neither can be derived from the other
 * without reading the transcript, so this is where the transcript gets read.
 *
 * Two things make the translation less obvious than it sounds, and both are why the panel is not
 * asked to do it:
 *
 * - **The picker counts MESSAGES; the id counts LINES.** A transcript line is a tool result, an
 *   attachment, a title record or a person speaking, and only the last of those is an entry in the
 *   picker. `isHumanTurnStart` is this repository's answer to which is which, and it carries a
 *   scar: a summarizer once read a tool result as the person speaking because it tested
 *   `type === "user"` alone.
 * - **The panel may be looking at a different set.** It renders in file order, so a session that
 *   has been rewound before shows its abandoned turns alongside its live ones, while the picker
 *   lists only the live conversation. Counting here does not make that agree -- nothing can --
 *   which is exactly why the count travels with the text that has to match it.
 */
import { claudeAdapter } from "./sources/claudeTranscript.ts";
import { isHumanTurnStart } from "./humanTurns.ts";

/** Where a message sits, said the way the rewind picker is addressed. */
export interface MessageAnchor {
  /** How many messages back from the newest, counting the newest as 1. */
  fromEnd: number;
  /** What that message says, which is what proves the picker landed on the right row. */
  text: string;
}

export class MessageAnchorError extends Error {}

/**
 * The raw line index an event id names, for a session that must be the one addressed.
 *
 * The session is checked rather than ignored because an id carries one: a panel that sent the row
 * it was looking at while the reader had moved to another session would otherwise anchor into a
 * transcript nobody asked about, and the count would be perfectly valid nonsense.
 */
export function lineFromEventId(eventId: string, sessionId: string): number {
  const match = /^([a-z]+):(.+):line:(\d+)$/.exec(eventId);
  if (!match) throw new MessageAnchorError(`"${eventId}" is not an event id`);
  if (match[1] !== "claude") throw new MessageAnchorError("only a claude event can be forked from");
  if (match[2]!.toLowerCase() !== sessionId.toLowerCase()) {
    throw new MessageAnchorError("that event belongs to a different session");
  }
  return Number(match[3]);
}

/**
 * Where the message on `line` sits among the transcript's messages.
 *
 * Reads the whole file, which is deliberate: this happens once per fork, and the alternative --
 * the event index's byte offsets -- answers a question about lines rather than about messages, so
 * it would still need every line parsed to count the ones that are people talking.
 */
export async function anchorAtLine(
  transcriptPath: string,
  line: number,
): Promise<MessageAnchor> {
  const text = await Bun.file(transcriptPath).text();
  const lines = text.split("\n");

  let target: string | null = null;
  let after = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (!raw) continue;
    const parsed = claudeAdapter.processLine(raw)?.event;
    if (!parsed || !isHumanTurnStart(parsed)) continue;
    if (index === line) {
      target = messageText(parsed);
      after = 0;
      continue;
    }
    if (target !== null) after += 1;
  }
  if (target === null) {
    throw new MessageAnchorError("that line is not a message somebody wrote");
  }
  // The newest message is one back from the end, not none, which is what the picker's opening
  // selection means: it starts BELOW the newest, on `(current)`.
  return { fromEnd: after + 1, text: target };
}

/** What the picker would show for this message: its prose, and only its prose. */
function messageText(parsed: { blocks: readonly { kind: string; text?: string }[] }): string {
  for (const block of parsed.blocks) {
    if (block.kind !== "text") continue;
    const text = block.text?.trim();
    if (text) return text;
  }
  return "";
}
