// What a Bot's session says on the Mac's audio channel (the speech process,
// `agent-feed/speech/speech_server.py`), to someone who is listening while doing something else:
// when its turn finishes, when it asks a question and waits, and once more if that wait goes on.
// And a reply read out loud when a person asks for it (`readAloud`, behind the feed's speaker).
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

import { AUDIO_SPEAK_MAX_CHARS, SPEECH_READ_MAX_CHARS, type BotRecord } from "@agentdesk/agent-feed-wire";
import { speechPort } from "@/audio/audioConfig";
import { opencodeLastReply } from "@/transcripts/catalog/opencodeCatalog";
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

/** A reply without the blocks a session writes about its own turn, which are not part of what it said. */
export function withoutReports(reply: string): string {
  return reply.replace(/<(task-state|spoken-status|next-suggestions-for-user)>[\s\S]*?(<\/\1>|$)/g, " ");
}

/** The first few sentences of a reply, for a turn that wrote no block. */
export function replyOpening(reply: string): string {
  const text = speakableReply(withoutReports(reply), FALLBACK_CHARACTERS * 2);
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

/** A speaker's name as it opens a message: a sentence of its own, so a pause follows it. */
function spokenName(speaker: string): string {
  return `${speaker.replace(/[.!?\s]+$/, "")}.`;
}

/** What `speaker` says, for a session with this status (or, with none, this reply), on this occasion. */
export function spokenAnnouncement(
  speaker: string,
  occasion: SpeechOccasion,
  status: SessionSpokenStatus | undefined,
  reply: string | null,
): string | null {
  const name = spokenName(speaker);
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

/**
 * What the speech process answered for one message: how many heard it and for how long, whether it
 * was stopped part way, or null when nobody listened.
 */
export type SpeechHeard = { listeners: number; durationMs: number; cancelled: boolean } | null;

/** What became of one queued message. */
export type SpeechOutcome =
  | { said: true; listeners: number; durationMs: number }
  | { said: false; why: "nobody-listening" | "replaced" | "stopped" | "failed" };

type Announcement = {
  key: string;
  text: string;
  tone: SpeechTone | null;
  urgent: boolean;
  /** The voice to say it in, or null for the voice in use (`sessionVoices.ts`). */
  voice: string | null;
  settle: (outcome: SpeechOutcome) => void;
};

/**
 * Sends one message to the speech process, named by `ref` (its key in the queue) so it can be
 * cancelled by that name, in `voice` when one is named; nobody listening is an answer, not a failure.
 */
export type SpeechSay = (
  text: string,
  tone: SpeechTone | null,
  ref: string,
  voice?: string | null,
) => Promise<SpeechHeard>;

async function sayOnMac(
  text: string,
  tone: SpeechTone | null,
  ref: string,
  voice?: string | null,
): Promise<SpeechHeard> {
  const response = await fetch(`http://127.0.0.1:${speechPort()}/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ref, ...(tone ? { tone } : {}), ...(voice ? { voice } : {}) }),
  });
  if (response.status === 400 && voice) {
    const code = ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
    if (code === "unknown_voice") {
      // A voice given out before the speech process stopped listing it: said in the voice in use
      // rather than not at all, and said here so the pool can be put right.
      console.error(`[speech] the speech process has no voice ${JSON.stringify(voice)}; saying it in the voice in use`);
      return sayOnMac(text, tone, ref, null);
    }
    throw new Error(`the speech process answered 400 (${code ?? "no code"})`);
  }
  if (response.status === 409) {
    console.log(`[speech] nobody listening, not said: ${JSON.stringify(text.slice(0, 60))}`);
    return null;
  }
  if (!response.ok) throw new Error(`the speech process answered ${response.status}: ${await response.text()}`);
  const heard = (await response.json()) as { listeners: number; durationMs: number; cancelled?: boolean };
  console.log(`[speech] said ${JSON.stringify(text.slice(0, 60))} (${tone ?? "no tone"}): ${JSON.stringify(heard)}`);
  return { listeners: heard.listeners, durationMs: heard.durationMs, cancelled: heard.cancelled === true };
}

/**
 * Stops the newest message `ref` named, wherever it is: still being made, or made and still playing.
 * The speech process stops making it and tells every page to drop what it holds of it.
 */
async function cancelOnMac(ref: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${speechPort()}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  if (!response.ok) throw new Error(`the speech process answered ${response.status} to a cancel`);
}

/**
 * The one line of messages. `say` resolves once the speech process has made a message, which is
 * when the next can go: the speech process plays them in the order it made them. Each `enqueue`
 * resolves with what became of its own message.
 */
export function createSpeechQueue(say: SpeechSay = sayOnMac) {
  const queue: Announcement[] = [];
  let sending = false;

  async function drain(): Promise<void> {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        const heard = await say(next.text, next.tone, next.key, next.voice);
        if (!heard) next.settle({ said: false, why: "nobody-listening" });
        else if (heard.cancelled) next.settle({ said: false, why: "stopped" });
        else next.settle({ said: true, listeners: heard.listeners, durationMs: heard.durationMs });
      } catch (error) {
        console.error(`[speech] ${next.key}: not said`, error);
        next.settle({ said: false, why: "failed" });
      }
    }
    sending = false;
  }

  return {
    /**
     * Queues `text` from `key` (a Bot, or a session no Bot holds) in `voice`, replacing anything it
     * queued that has not gone yet.
     */
    enqueue(
      key: string,
      text: string,
      tone: SpeechTone | null,
      urgent: boolean,
      voice: string | null = null,
    ): Promise<SpeechOutcome> {
      return new Promise((settle) => {
        const stale = queue.findIndex((item) => item.key === key);
        if (stale !== -1) queue.splice(stale, 1)[0]?.settle({ said: false, why: "replaced" });
        const item = { key, text, tone, urgent, voice, settle };
        const firstCalm = queue.findIndex((queued) => !queued.urgent);
        if (urgent && firstCalm !== -1) queue.splice(firstCalm, 0, item);
        else queue.push(item);
        if (!sending) {
          sending = true;
          void drain();
        }
      });
    },
    /** Takes `key`'s message out of the line if it has not gone yet. The one being made is not here. */
    withdraw(key: string): void {
      const waiting = queue.findIndex((item) => item.key === key);
      if (waiting !== -1) queue.splice(waiting, 1)[0]?.settle({ said: false, why: "stopped" });
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

/**
 * Who is speaking for a session no Bot holds: its title, else the folder it works in, since the
 * listener knows a session by what the panel lists it as.
 */
export function unheldSpeakerName(session: Pick<Session, "title" | "project">): string {
  const title = (session.title ?? "").replace(/\s+/g, " ").trim();
  if (title) return title;
  const folder = session.project.split("/").filter(Boolean).pop();
  return folder ? `A session in ${folder}` : "A session";
}

/** What a session's latest turn ended on, for a turn that wrote no block. */
async function latestReply(session: Session): Promise<string | null> {
  if (session.transcriptPath) return lastAgentReply(session.transcriptPath);
  return session.source === "opencode" ? opencodeLastReply(session.sessionId) : null;
}

/**
 * Says what `session` has to say on `occasion`, through the one queue: as the Bot that holds it on
 * the canvas, in `voice` (`sessionVoices.ts`), or as itself when no Bot does (`bot` null). Null
 * `voice` is the voice in use.
 */
export async function speakSession(
  bot: BotRecord | null,
  session: Session,
  occasion: SpeechOccasion,
  voice: string | null = null,
): Promise<void> {
  const status = session.spokenStatus;
  const reply = occasion === "finished" && status?.from !== "block" ? await latestReply(session) : null;
  const speaker = bot ? speakerName(bot, session) : unheldSpeakerName(session);
  const text = spokenAnnouncement(speaker, occasion, status, reply);
  if (!text) {
    console.log(`[speech] ${speaker}: nothing to say for ${occasion}`);
    return;
  }
  const urgent = occasion !== "finished" || needsAttention(status);
  // One message waiting per Bot, and per session for one no Bot holds.
  const key = bot ? bot.botId : `${session.source}:${session.sessionId}`;
  await speechQueue.enqueue(key, text, urgent ? "attention" : "done", urgent, voice);
}

/**
 * What a session's own message to the listener is said as, and its place in the queue: its own key,
 * beside the session's announcements, so neither replaces the other, while its next message replaces
 * it if it has not gone yet. Null when nothing in `text` can be said.
 */
export function sessionMessage(
  bot: Pick<BotRecord, "name" | "sessionAnchors"> | null,
  session: Session,
  text: string,
): { key: string; speaker: string; text: string } | null {
  const words = speakableReply(text);
  if (!words) return null;
  const speaker = bot ? speakerName(bot, session) : unheldSpeakerName(session);
  return { key: `said:${session.source}:${session.sessionId}`, speaker, text: `${spokenName(speaker)} ${words}` };
}

/**
 * Says `text`, which a session wrote for whoever is listening (`tools/agent-radio-say.sh`), as that
 * session: named as its announcements are, in `voice`, after the "done" tone and behind anything that
 * needs the person. Null when nothing in it can be said.
 */
export async function sayForSession(
  bot: BotRecord | null,
  session: Session,
  text: string,
  voice: string | null,
): Promise<{ outcome: SpeechOutcome; speaker: string } | null> {
  const message = sessionMessage(bot, session, text);
  if (!message) return null;
  const outcome = await speechQueue.enqueue(message.key, message.text, "done", false, voice);
  return { outcome, speaker: message.speaker };
}

/** A reply as it is read out loud, on Agent Radio or on the device that asked: empty when nothing can be said. */
export function readableReply(reply: string): string {
  return speakableReply(withoutReports(reply), SPEECH_READ_MAX_CHARS);
}

/**
 * A reply made into speech for one page to play itself (`speech_server.py`'s `/render`): the speech
 * process's answer, whose body is the PCM as it is made. Outside the queue, so it never waits for an
 * announcement or stops one. `ref` names it for `stopHere`.
 */
export async function speechForPage(reply: string, ref: string): Promise<Response | null> {
  const text = readableReply(reply);
  if (!text) return null;
  return fetch(`http://127.0.0.1:${speechPort()}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ref }),
  });
}

/** Stops making the speech `ref` names. The page stops playing it on its own. */
export async function stopSpeechForPage(ref: string): Promise<void> {
  await cancelOnMac(ref);
}

/** The queue key, and the speech process's ref, of a reply read out loud: one at a time. */
const READ_ALOUD = "read-aloud";

/** Stops the reply being read out loud, wherever it is: waiting its turn, being made, or playing. */
export async function stopReading(): Promise<void> {
  speechQueue.withdraw(READ_ALOUD);
  await cancelOnMac(READ_ALOUD);
}

/**
 * Reads a reply out loud because a person asked (the feed's speaker), ahead of the sessions' calm
 * announcements and with no tone, since the person knows what is coming. Its report blocks are left
 * out. One reply at a time: asking for another stops the one being read first. Null when nothing in
 * it can be said.
 */
export async function readAloud(reply: string): Promise<SpeechOutcome | null> {
  const text = readableReply(reply);
  if (!text) return null;
  // Before queueing the new one, so the cancel, which names the newest message, cannot reach it.
  await stopReading().catch((error: unknown) => console.error("[speech] could not stop the last reading", error));
  return speechQueue.enqueue(READ_ALOUD, text, null, true);
}
