// A voice for each session a Bot holds on the canvas, so whoever listens to Agent Radio tells the
// sessions apart by ear before a word of what they say (`BotRecord.sessionVoices`).
//
// Given the first time a session is announced, from one pool shared by every Bot, and held only while
// the Bot holds the session on the canvas (`curatedKeys`, the same sessions that are announced as the
// Bot's). A session taken off the canvas or out of the Bot frees its voice for the next session; its
// entry stays until that voice is given to another, so one put back before then speaks as it did. A
// session no Bot holds speaks in the voice in use, as does every session once the pool is spent.

import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { BotStore } from "@/bots/botStore";
import { curatedKeys } from "@/push/turnFinishedNotifier";

/**
 * The voices given out, in order: the speech process's 25 everyday English voices, men and women
 * alternating, each in the order the clarity measurements ranked them (pace, high-frequency share and
 * syllable crispness, 2026-10-24). None is slow or muffled by those measurements.
 */
export const VOICE_POOL = [
  "Easton",
  "Hadley",
  "Miles",
  "Lottie",
  "Micah",
  "Juniper",
  "Alfie",
  "Elodie-Rose",
  "Teddy",
  "Zoey",
  "Russell",
  "Delia",
  "Hugh",
  "Pippa",
  "Toby",
  "Everly",
  "Edwin",
  "Imogen",
  "Preston",
  "Bryony",
  "Spencer",
  "Maeve",
  "Trevor",
  "Harper",
  "Freya",
] as const;

/** Which session holds each voice now. Only a session its Bot still holds on the canvas holds one. */
export function voicesHeld(bots: readonly BotRecord[]): Map<string, string> {
  const held = new Map<string, string>();
  for (const bot of bots) {
    const holding = curatedKeys(bot);
    for (const [key, voice] of Object.entries(bot.sessionVoices ?? {})) {
      if (holding.has(key) && !held.has(voice)) held.set(voice, key);
    }
  }
  return held;
}

/**
 * The voice `key` in `botId` speaks in: its own while nobody else holds it, otherwise the first free
 * one in the pool, which `given` says is new to it. Null when every voice is held.
 */
export function voiceFor(
  bots: readonly BotRecord[],
  botId: string,
  key: string,
): { voice: string | null; given: boolean } {
  const own = bots.find((bot) => bot.botId === botId)?.sessionVoices?.[key];
  const held = voicesHeld(bots);
  if (own && (held.get(own) ?? key) === key) return { voice: own, given: false };
  const free = VOICE_POOL.find((voice) => !held.has(voice)) ?? null;
  return { voice: free, given: free !== null };
}

/** `bots` with `voice` given to `key` in `botId`, and taken off every session that left it behind. */
function giveVoice(bots: readonly BotRecord[], botId: string, key: string, voice: string): BotRecord[] {
  return bots.map((bot) => {
    const voices = Object.fromEntries(Object.entries(bot.sessionVoices ?? {}).filter(([, held]) => held !== voice));
    if (bot.botId === botId) voices[key] = voice;
    const changed = bot.botId === botId || Object.keys(voices).length !== Object.keys(bot.sessionVoices ?? {}).length;
    return changed ? { ...bot, sessionVoices: voices } : bot;
  });
}

export function createSessionVoices(store: Pick<BotStore, "snapshot" | "mutate">) {
  return {
    /** The voice a Bot's session is announced in, given to it now if it has none; null for the voice in use. */
    async voiceOf(botId: string, key: string): Promise<string | null> {
      const { bots } = await store.snapshot();
      const read = voiceFor(bots, botId, key);
      if (!read.given) return read.voice;
      // Asked again inside the write, which sees every write before it: two sessions announced at
      // once must not both take the first free voice.
      return store.mutate((snapshot) => {
        const pick = voiceFor(snapshot.bots, botId, key);
        if (!pick.given || !pick.voice || !snapshot.bots.some((bot) => bot.botId === botId)) {
          return { snapshot, value: pick.voice };
        }
        return {
          snapshot: {
            ...snapshot,
            revision: snapshot.revision + 1,
            bots: giveVoice(snapshot.bots, botId, key, pick.voice),
          },
          value: pick.voice,
        };
      });
    },
  };
}
