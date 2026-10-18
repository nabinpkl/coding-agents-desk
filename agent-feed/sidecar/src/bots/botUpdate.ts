// Renaming a Bot, restyling it, or naming its Father: the record with the named fields
// replaced and everything else kept -- except that naming a Father un-names every other Bot's,
// because a machine has one Father.
//
// A setting, not an act: no idempotency record, and the same command twice lands the same
// record. Only the keys the caller named move -- the normalizer carries presence, so an
// absent field and an emptied one stay distinguishable all the way here.

import type { BotDeleted, BotRecord, BotView, UpdateBotCommand } from "@agentdesk/agent-feed-wire";
import type { StoredBotSnapshot } from "@/bots/botStore";
import type { BotStore } from "@/bots/botStore";
import type { NormalizedUpdateBot } from "@/bots/botCommands";
import { normalizeUpdateBot } from "@/bots/botCommands";
import { sessionKey } from "@/bots/botIdempotency";
import { BotConflictError, BotForbiddenError, BotInvalidError, BotNotFoundError, type BotActor } from "@/bots/botTypes";

/**
 * Drops a Father the Bot no longer holds.
 *
 * Called in the same write that detaches, so no update can strand a Father the Bot detached:
 * the home would otherwise name a session the Bot has forgotten and read as missing for a
 * reason the reader can see but never caused.
 */
export function clearDetachedFather(bot: BotRecord, removing: ReadonlySet<string>): BotRecord {
  if (bot.fatherSession && removing.has(sessionKey(bot.fatherSession))) {
    const { fatherSession: _dropped, ...rest } = bot;
    return rest;
  }
  return bot;
}

export function updateBotRecord(
  snapshot: StoredBotSnapshot,
  botId: string,
  command: NormalizedUpdateBot,
): { snapshot: StoredBotSnapshot; value: BotRecord } {
  const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
  if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
  const bot = snapshot.bots[index]!;

  let updated = bot;
  if (command.name !== undefined) {
    // Siblings only: renaming a Bot to the name it already has is the common retry, not a
    // collision, and the creation check has no self to exclude.
    if (
      snapshot.bots.some(
        (other) =>
          other.botId !== botId && other.name.normalize("NFKC").toLocaleLowerCase("en-US") === command.normalizedName,
      )
    ) {
      throw new BotConflictError(`a Bot named "${command.name}" already exists`);
    }
    updated = { ...updated, name: command.name };
  }
  if (command.iconUrl !== undefined) {
    const { iconUrl: _dropped, ...rest } = updated;
    // Null is the clear the wire documents: an absent icon renders the initials, so forgetting
    // the URL is forgetting the field rather than writing an empty one.
    updated = command.iconUrl === null ? rest : { ...rest, iconUrl: command.iconUrl };
  }
  if (command.metadata !== undefined) {
    const metadata = { ...updated.metadata };
    // Present keys only -- each replaces wholesale, and the rest stay. An emptied role or
    // description arrives as undefined, which deletes the caption rather than writing blank
    // text the roster would then draw.
    if ("role" in command.metadata) {
      if (command.metadata.role === undefined) delete metadata.role;
      else metadata.role = command.metadata.role;
    }
    if ("description" in command.metadata) {
      if (command.metadata.description === undefined) delete metadata.description;
      else metadata.description = command.metadata.description;
    }
    if (command.metadata.labels !== undefined) metadata.labels = command.metadata.labels;
    if (command.metadata.custom !== undefined) metadata.custom = command.metadata.custom;
    updated = { ...updated, metadata };
  }
  if (command.fatherSession !== undefined) {
    if (command.fatherSession === null) {
      const { fatherSession: _dropped, ...rest } = updated;
      updated = rest;
    } else {
      // Membership, not resolution: the stored record is the authority on what this Bot
      // claims, and a Father the catalog has forgotten still says missing rather than
      // silently unnameable.
      if (!bot.sessionRefs.some((ref) => sessionKey(ref) === sessionKey(command.fatherSession!))) {
        throw new BotNotFoundError(`session ${sessionKey(command.fatherSession)} is not attached to this Bot`);
      }
      updated = { ...updated, fatherSession: command.fatherSession };
    }
  }

  const bots = [...snapshot.bots];
  bots[index] = updated;
  return {
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      bots: command.fatherSession ? withOneFather(bots, botId) : bots,
    },
    value: updated,
  };
}

/**
 * Clears the Father on every Bot but this one.
 *
 * One Father at a time across the machine, in the same write that names it, so the store never
 * holds two. It used to hold one per Bot, and the home shows only the first in canvas order: a
 * second Father named on another Bot was saved, reported as named, and never shown anywhere.
 */
function withOneFather(bots: readonly BotRecord[], fatherBotId: string): BotRecord[] {
  return bots.map((bot) => {
    if (bot.botId === fatherBotId || !bot.fatherSession) return bot;
    const { fatherSession: _dropped, ...rest } = bot;
    return rest;
  });
}

/**
 * Renaming, restyling, naming a Father, and forgetting: the registry's record-level acts.
 *
 * Beside the starter and the retirer, which own bringing sessions into and out of existence:
 * those change what is running, these change what the roster says, and the registry stays the
 * thin dispatcher that checks the actor and hands over.
 */
export class BotRecordEditor {
  constructor(
    private readonly store: BotStore,
    private readonly view: (record: BotRecord) => Promise<BotView>,
  ) {}

  /**
   * Renames this Bot, restyles it, or names its Father.
   *
   * A setting, so no idempotency record: sending it twice lands the same record, and the name
   * check below is what makes a stale rename detectable rather than silently applied. The
   * Father must be a session the Bot holds, checked against the stored record for
   * `detachSessions`' reason -- the catalog forgetting a session must not make it unnamed.
   */
  async updateBot(botId: string, command: UpdateBotCommand, actor: BotActor): Promise<BotView> {
    if (actor.kind !== "user") {
      throw new BotForbiddenError("only the authenticated user may edit a Bot");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(botId)) throw new BotInvalidError("botId is invalid");
    const normalized = normalizeUpdateBot(command);
    const record = await this.store.mutate((snapshot) => updateBotRecord(snapshot, botId, normalized));
    return this.view(record);
  }

  /**
   * Forgets this Bot. The sessions survive: detaching is forgetting, and this is detaching
   * everything at once -- panes keep running, transcripts stay in the catalog, worktrees and
   * branches stay on disk. Only `retireSessions` ends anything.
   *
   * No idempotency record either, for the opposite reason from the settings above: a replay
   * lands on a Bot that is gone, and 404 saying so is the honest answer. The ledger is pruned
   * of this Bot's entries in the same write, because a stored record pointing at a missing
   * Bot fails the snapshot's own validation on the next read.
   */
  async deleteBot(botId: string, actor: BotActor): Promise<BotDeleted> {
    if (actor.kind !== "user") {
      throw new BotForbiddenError("only the authenticated user may delete a Bot");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(botId)) throw new BotInvalidError("botId is invalid");
    const record = await this.store.mutate((snapshot) => {
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const idempotency = Object.fromEntries(
        Object.entries(snapshot.idempotency).filter(([, entry]) => entry.botId !== botId),
      );
      return {
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          bots: snapshot.bots.filter((bot) => bot.botId !== botId),
          idempotency,
        },
        value: snapshot.bots[index]!,
      };
    });
    return { deleted: record.botId };
  }
}
