// Answering a resent request with the Bot the first one made, rather than a second Bot.
//
// A request carries its own id, and the stored snapshot remembers which Bot that id
// produced together with a signature of what was asked. The same id with different data
// is a conflict, not a replay.

import type { BotRecord, BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { StoredBotSnapshot } from "@/bots/botStore";
import { BotConflictError, type BotActor } from "@/bots/botTypes";

/** Beyond this many remembered requests the oldest are forgotten. */
const MAX_IDEMPOTENCY_ENTRIES = 512;

export function sessionKey(ref: BotSessionRef): string {
  return `${ref.source}:${ref.sessionId}`;
}

export function actorKey(actor: BotActor): string {
  return actor.kind === "user" ? "user" : `agent:${sessionKey(actor.session)}`;
}

export function commandSignature(value: unknown): string {
  return JSON.stringify(value);
}

export function appendIdempotency(
  snapshot: StoredBotSnapshot,
  key: string,
  signature: string,
  botId: string,
): StoredBotSnapshot["idempotency"] {
  const idempotency = { ...snapshot.idempotency, [key]: { signature, botId } };
  while (Object.keys(idempotency).length > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = Object.keys(idempotency)[0];
    if (!oldest) break;
    delete idempotency[oldest];
  }
  return idempotency;
}

export function priorBot(
  snapshot: StoredBotSnapshot,
  idempotencyKey: string,
  signature: string,
): BotRecord | undefined {
  const prior = snapshot.idempotency[idempotencyKey];
  if (!prior) return undefined;
  if (prior.signature !== signature) {
    throw new BotConflictError("requestId was reused with different Bot data");
  }
  const existing = snapshot.bots.find((bot) => bot.botId === prior.botId);
  if (!existing) throw new Error(`bots.json idempotency record references missing Bot ${prior.botId}`);
  return existing;
}
