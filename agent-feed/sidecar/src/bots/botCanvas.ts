// Whether a Bot, and each of its sessions, stands on the panel's canvas, and where on the strip.
//
// On the record rather than in the browser, because a browser keeps it per origin and per profile:
// a phone and the Mac disagreed about which Bots were showing, and a Bot on a peer had its state
// kept by whichever browser last looked at it. The record is the one place every surface reads.
//
// A setting, not an act: no idempotency record, and the same command twice lands the same state.

import {
  BOT_CANVAS_NAMES,
  type BotCanvasMembership,
  type BotCanvasName,
  type BotRecord,
  type BotSessionRef,
  type SetBotCanvasCommand,
} from "@agentdesk/agent-feed-wire";
import type { StoredBotSnapshot } from "@/bots/botStore";
import { normalizeSessionRef } from "@/bots/botCommands";
import { sessionKey } from "@/bots/botIdempotency";
import { BotInvalidError, BotNotFoundError } from "@/bots/botTypes";

/** Bounded like every other list a command carries, so a body cannot name a Bot's worth twice over. */
const MAX_SESSION_CHANGES = 256;

export interface NormalizedBotCanvas {
  onCanvas?: boolean;
  sessions: (BotSessionRef & { onCanvas: boolean })[];
  position?: number;
  /** Each named canvas's new place, or null to take the Bot off it. Empty when none is named. */
  canvases: [BotCanvasName, BotCanvasMembership | null][];
}

function normalizeRefList(raw: unknown, field: string): BotSessionRef[] {
  if (!Array.isArray(raw) || raw.length > MAX_SESSION_CHANGES) {
    throw new BotInvalidError(`${field} must be a list of at most ${MAX_SESSION_CHANGES} sessions`);
  }
  return raw.map((ref: unknown) => normalizeSessionRef(ref));
}

function normalizeCanvases(raw: unknown): [BotCanvasName, BotCanvasMembership | null][] {
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BotInvalidError("canvases must map a canvas name to its place or null");
  }
  return Object.entries(raw).map(([name, membership]: [string, unknown]) => {
    if (!(BOT_CANVAS_NAMES as readonly string[]).includes(name)) {
      throw new BotInvalidError(`there is no canvas named "${name}"`);
    }
    if (membership === null) return [name as BotCanvasName, null];
    if (typeof membership !== "object" || Array.isArray(membership)) {
      throw new BotInvalidError(`canvases.${name} must be null or { sessionRefs, exclusiveSessionRefs? }`);
    }
    const { sessionRefs, exclusiveSessionRefs } = membership as Record<string, unknown>;
    const shown = normalizeRefList(sessionRefs, `canvases.${name}.sessionRefs`);
    if (exclusiveSessionRefs === undefined) return [name as BotCanvasName, { sessionRefs: shown }];
    const only = normalizeRefList(exclusiveSessionRefs, `canvases.${name}.exclusiveSessionRefs`);
    // Exclusive to a canvas means shown there, so one the canvas does not list is a contradiction
    // rather than a session to quietly hide from the Feed and show nowhere.
    const shownKeys = new Set(shown.map(sessionKey));
    const stray = only.find((ref) => !shownKeys.has(sessionKey(ref)));
    if (stray) throw new BotInvalidError(`session ${sessionKey(stray)} is exclusive to ${name} but not shown there`);
    return [name as BotCanvasName, { sessionRefs: shown, exclusiveSessionRefs: only }];
  });
}

export function normalizeBotCanvas(command: SetBotCanvasCommand): NormalizedBotCanvas {
  if (command.onCanvas !== undefined && typeof command.onCanvas !== "boolean") {
    throw new BotInvalidError("onCanvas must be a boolean");
  }
  const raw: unknown = command.sessions ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_SESSION_CHANGES) {
    throw new BotInvalidError(`sessions must be a list of at most ${MAX_SESSION_CHANGES} changes`);
  }
  const sessions = raw.map((change: unknown) => {
    const onCanvas = (change as { onCanvas?: unknown } | null)?.onCanvas;
    if (typeof onCanvas !== "boolean") throw new BotInvalidError("each session change needs onCanvas");
    return { ...normalizeSessionRef(change), onCanvas };
  });
  const position: unknown = command.position;
  if (position !== undefined && !(Number.isSafeInteger(position) && Number(position) >= 0)) {
    throw new BotInvalidError("position must be a nonnegative integer");
  }
  const canvases = normalizeCanvases(command.canvases);
  if (command.onCanvas === undefined && sessions.length === 0 && position === undefined && canvases.length === 0) {
    throw new BotInvalidError("onCanvas, sessions, position or canvases is required");
  }
  return {
    ...(command.onCanvas === undefined ? {} : { onCanvas: command.onCanvas }),
    sessions,
    ...(position === undefined ? {} : { position: position as number }),
    canvases,
  };
}

/**
 * The record with this list as its off-canvas sessions, omitting the field when it is empty.
 *
 * Omitted rather than stored empty, and the same for `offCanvas: false`, so a Bot nobody has taken
 * off the canvas reads in `bots.json` exactly as it did before these fields existed.
 */
export function withOffCanvasSessions(bot: BotRecord, refs: readonly BotSessionRef[]): BotRecord {
  const { offCanvasSessionRefs: _dropped, ...rest } = bot;
  return refs.length === 0 ? rest : { ...rest, offCanvasSessionRefs: [...refs] };
}

/**
 * The record with these canvases, keeping only sessions it still holds, in its own order and as its
 * stored references. Omits the field when no canvas is left, and a canvas's exclusive list when it
 * is empty, for `withOffCanvasSessions`'s reason.
 */
export function withCanvases(bot: BotRecord, canvases: BotRecord["canvases"]): BotRecord {
  const { canvases: _dropped, ...rest } = bot;
  const kept = Object.entries(canvases ?? {}).map(([name, membership]) => {
    const keys = new Set((membership?.sessionRefs ?? []).map(sessionKey));
    const only = new Set((membership?.exclusiveSessionRefs ?? []).map(sessionKey));
    const sessionRefs = bot.sessionRefs.filter((ref) => keys.has(sessionKey(ref)));
    const exclusiveSessionRefs = sessionRefs.filter((ref) => only.has(sessionKey(ref)));
    return [name, exclusiveSessionRefs.length === 0 ? { sessionRefs } : { sessionRefs, exclusiveSessionRefs }] as const;
  });
  return kept.length === 0 ? rest : { ...rest, canvases: Object.fromEntries(kept) };
}

export function setBotCanvas(
  snapshot: StoredBotSnapshot,
  botId: string,
  command: NormalizedBotCanvas,
): { snapshot: StoredBotSnapshot; value: BotRecord } {
  const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
  if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
  const bot = snapshot.bots[index]!;

  const held = new Map(bot.sessionRefs.map((ref) => [sessionKey(ref), ref]));
  const named = command.canvases.flatMap(([, membership]) => membership?.sessionRefs ?? []);
  const absent = [...command.sessions, ...named].find((change) => !held.has(sessionKey(change)));
  if (absent) throw new BotNotFoundError(`session ${sessionKey(absent)} is not attached to this Bot`);

  const off = new Set((bot.offCanvasSessionRefs ?? []).map(sessionKey));
  for (const change of command.sessions) {
    if (change.onCanvas) off.delete(sessionKey(change));
    else off.add(sessionKey(change));
  }
  // In the Bot's own session order, and as the STORED references, so this can never be the way
  // something extra is written into a record.
  let updated = withOffCanvasSessions(
    bot,
    bot.sessionRefs.filter((ref) => off.has(sessionKey(ref))),
  );
  if (command.onCanvas !== undefined) {
    const { offCanvas: _dropped, ...rest } = updated;
    updated = command.onCanvas ? rest : { ...rest, offCanvas: true };
  }
  if (command.position !== undefined) updated = { ...updated, canvasPosition: command.position };
  if (command.canvases.length > 0) {
    const canvases: NonNullable<BotRecord["canvases"]> = { ...updated.canvases };
    for (const [name, membership] of command.canvases) {
      if (membership === null) delete canvases[name];
      else canvases[name] = membership;
    }
    updated = withCanvases(updated, canvases);
  }

  const bots = [...snapshot.bots];
  bots[index] = updated;
  return { snapshot: { ...snapshot, revision: snapshot.revision + 1, bots }, value: updated };
}
