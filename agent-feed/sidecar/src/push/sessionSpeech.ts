// What a Bot's session says on the Mac's audio channel (the speech process,
// `agent-feed/speech/speech_server.py`), to someone who is listening while doing something else:
// when its turn finishes, when it asks a question and waits, and once more if that wait goes on.
//
// It says the session's spoken status (`transcripts/spokenStatus.ts`): the short lines the session
// closed its turn with, or the question it is waiting on. A turn that wrote no block says its
// reply's first sentences instead, never the whole reply: a listener wants the news, and can read
// the rest. A tone goes first, one for "this needs you" and another for "this is done", so the kind
// of news is heard before a word of it.
//
// Announcements go out one at a time. One that needs the person goes ahead of the rest, and a Bot
// with a newer one waiting replaces its older one, so a burst of sessions finishing is heard as the
// latest word from each rather than a backlog.

import { AUDIO_SPEAK_MAX_CHARS, type BotRecord } from "@agentdesk/agent-feed-wire";
import { speechPort } from "@/audio/audioConfig";
import { normalizedLine } from "@/transcripts/claude/claudeNormalize";
import { isHumanTurnStart } from "@/transcripts/humanTurns";
import type { SessionSpokenStatus, SpokenStatusKind } from "@/transcripts/spokenStatus";
import { completeEnd, linesBefore } from "@/transcripts/transcript-reads/transcriptLines";
import type { Session } from "@/transcripts/transcriptTypes";

/** Why a session is being heard from. */
export type SpeechOccasion = "finished" | "question" | "reminder";

/** The tone before an announcement: `attention` when it needs the person or something failed. */
export type SpeechTone = "attention" | "done";

/** How many lines back the reply is looked for. A turn's last text is near its end. */
const LINES_BACK = 400;
/** A reply with no block is cut to this many sentences: the news, not the whole message. */
const FALLBACK_SENTENCES = 2;
const FALLBACK_CHARACTERS = 300;

/** How each kind of line is introduced when spoken. A plain `done` line needs no introduction. */
const SPOKEN_KIND: Record<SpokenStatusKind, string> = {
  waiting: "Needs you",
  failed: "Failed",
  done: "",
  running: "Still running",
  note: "Note",
};

/** The newest text the agent wrote in the session's last turn, or null when it wrote none. */
export async function lastAgentReply(path: string): Promise<string | null> {
  let reply: string | null = null;
  let read = 0;
  await linesBefore(path, await completeEnd(path), (line) => {
    read += 1;
    const event = normalizedLine(line.text)?.result.event;
    if (!event) return read < LINES_BACK;
    if (isHumanTurnStart(event)) return false;
    if (event.type !== "assistant") return read < LINES_BACK;
    const text = event.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");
    if (!text) return read < LINES_BACK;
    reply = text;
    return false;
  });
  return reply;
}

/**
 * `markdown` as something to say. Code is named rather than read; links keep their words; headings,
 * emphasis, list marks, table rules and tags go. Cut at a sentence end to fit what the channel takes.
 */
export function speakableReply(markdown: string, limit = AUDIO_SPEAK_MAX_CHARS): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code) ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/[*_~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return sentenceEnd > limit / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}.`;
}

/** The first few sentences of a reply, for a turn that wrote no block. */
export function replyOpening(reply: string): string {
  const without = reply.replace(/<(task-state|spoken-status|next-suggestions-for-user)>[\s\S]*?<\/\1>/g, " ");
  const text = speakableReply(without, FALLBACK_CHARACTERS * 2);
  // Split where a sentence's end meets a space, so a reply that quotes punctuation ("..") keeps
  // the words around it rather than losing everything before the quote.
  const sentences = text.split(/(?<=[.!?])\s+/);
  return speakableReply(sentences.slice(0, FALLBACK_SENTENCES).join(" ").trim(), FALLBACK_CHARACTERS);
}

/** A line as it is said: introduced by its kind, ending as a sentence so a pause follows it. */
function spokenLine(line: SessionSpokenStatus["lines"][number]): string {
  const text = speakableReply(line.text).replace(/[.!?]*$/, ".");
  const kind = SPOKEN_KIND[line.kind];
  return kind ? `${kind}: ${text}` : text;
}

/** Whether a status needs the person or reports a failure, which decides the tone and the queue. */
export function needsAttention(status: SessionSpokenStatus | undefined): boolean {
  return status?.lines.some((line) => line.kind === "waiting" || line.kind === "failed") ?? false;
}

/** What `speaker` says, for a session with this status (or, with none, this reply), on this occasion. */
export function spokenAnnouncement(
  speaker: string,
  occasion: SpeechOccasion,
  status: SessionSpokenStatus | undefined,
  reply: string | null,
): string | null {
  const name = `${speaker.replace(/[.!?\s]+$/, "")}.`;
  if (occasion === "question" || occasion === "reminder") {
    const waiting = status?.lines.filter((line) => line.kind === "waiting") ?? [];
    if (waiting.length === 0) return null;
    const lead = occasion === "reminder" ? "Still waiting on you." : "";
    const asked =
      status?.from === "question"
        ? waiting.map((line) => `Asks: ${speakableReply(line.text)}`)
        : waiting.map(spokenLine);
    return speakableReply([name, lead, ...asked].filter(Boolean).join(" "));
  }
  if (status?.from === "block") return speakableReply([name, ...status.lines.map(spokenLine)].join(" "));
  if (!reply) return null;
  return speakableReply(`${name} ${replyOpening(reply)}`);
}

type Announcement = { key: string; text: string; tone: SpeechTone; urgent: boolean };

/** Sends one announcement to the speech process; nobody listening is not a failure. */
export type SpeechSay = (text: string, tone: SpeechTone) => Promise<void>;

async function sayOnMac(text: string, tone: SpeechTone): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${speechPort()}/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, tone }),
  });
  if (response.status === 409) {
    console.log(`[speech] nobody listening, not said: ${JSON.stringify(text.slice(0, 60))}`);
    return;
  }
  if (!response.ok) throw new Error(`the speech process answered ${response.status}: ${await response.text()}`);
  console.log(`[speech] said ${JSON.stringify(text.slice(0, 60))} (${tone}): ${await response.text()}`);
}

/**
 * The one line of announcements. `say` resolves once the speech process has made a message, which
 * is when the next can go: the speech process plays them in the order it made them.
 */
export function createSpeechQueue(say: SpeechSay = sayOnMac) {
  const queue: Announcement[] = [];
  let sending: Promise<void> | null = null;

  async function drain(): Promise<void> {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await say(next.text, next.tone);
      } catch (error) {
        console.error(`[speech] ${next.key}: not said`, error);
      }
    }
    sending = null;
  }

  return {
    /** Queues `text` from `key` (a Bot), replacing anything it queued that has not gone yet. */
    enqueue(key: string, text: string, tone: SpeechTone, urgent: boolean): Promise<void> {
      const stale = queue.findIndex((item) => item.key === key);
      if (stale !== -1) queue.splice(stale, 1);
      const item = { key, text, tone, urgent };
      const firstCalm = queue.findIndex((queued) => !queued.urgent);
      if (urgent && firstCalm !== -1) queue.splice(firstCalm, 0, item);
      else queue.push(item);
      sending ??= drain();
      return sending;
    },
  };
}

const speechQueue = createSpeechQueue();

/**
 * Who is speaking: the Bot, then the session's own name in it when it has one (its anchor, the
 * `Alan` in `Alan (checkout flow)`), so a Bot holding several sessions says which one.
 */
export function speakerName(bot: Pick<BotRecord, "name" | "sessionAnchors">, session: Session): string {
  const botName = bot.name.replace(/[.!?,\s]+$/, "");
  const anchor = bot.sessionAnchors?.[`${session.source}:${session.sessionId}`]?.trim();
  return anchor ? `${botName}, ${anchor}` : botName;
}

/** Says what `session` has to say on `occasion`, through the one queue. */
export async function speakSession(bot: BotRecord, session: Session, occasion: SpeechOccasion): Promise<void> {
  const status = session.spokenStatus;
  const reply =
    occasion === "finished" && status?.from !== "block" && session.transcriptPath
      ? await lastAgentReply(session.transcriptPath)
      : null;
  const text = spokenAnnouncement(speakerName(bot, session), occasion, status, reply);
  if (!text) {
    console.log(`[speech] ${bot.name}: nothing to say for ${occasion}`);
    return;
  }
  const urgent = occasion !== "finished" || needsAttention(status);
  await speechQueue.enqueue(bot.botId, text, urgent ? "attention" : "done", urgent);
}
