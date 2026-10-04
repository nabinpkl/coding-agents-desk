// Which machine each Bot on the canvas came from, and how several machines' rosters become one.
//
// A Bot is a directory and the sessions working in it, and until now every one of those directories
// was on the Mac the panel runs beside. It does not have to be: `tools/remote-sidecar.sh` puts an
// agent-feed sidecar on an ssh peer, `AGENTDESK_PANEL_REMOTE_SIDECARS` declares it, and the panel's
// dev server already proxies `/session/<id>/api/*` to it (`vite.config.ts`, `sidecarBoard.ts`). So
// the transport to another machine exists and is in use; what did not exist is a canvas that shows
// two machines at once, because the roster was one subscription to one sidecar.
//
// The Bot RECORD stays on the machine whose directory it names. That is the whole reason this is a
// lookup rather than a wire field: a registry may only claim sessions it can actually see, and the
// sidecar is the transcript reader -- the catalog, the bounded reads and the live watchers all live
// in it, which is `remote-sidecar.sh`'s own argument for running one on the peer instead of reading
// the peer's home from here. A Bot on the Mac holding references to oracle's sessions would be a
// second copy of oracle's truth, kept by something with no way to check it.
//
// Nothing here is remembered. Which machines exist comes from the dev server's live index, and a
// Bot's machine is re-derived from whichever roster it arrived in, for the reason `AGENTS.md` gives
// under "Panel state": this is a fact the stream owns, not a fact about how a reader arranged
// anything.

import type { BotSessionRef, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/**
 * One sidecar the canvas reads Bots from, with the data source pointed at it.
 *
 * `id` is the dev server's session id and is `undefined` for the panel's own sidecar, matching
 * `PanelSessionRef` and `sessionApiPrefix` -- the default answers on `/api`, which is what the
 * host's relay and every existing caller already speak, so naming it would have meant changing all
 * of them for nothing.
 */
export interface BotMachine {
  readonly id?: string;
  readonly label: string;
  readonly feed: SidecarDataSource;
}

/**
 * A machine's identity as a string, for React keys and for subscription identity.
 *
 * The empty string is the panel's own, which cannot collide with a declared peer: `sidecarBoard`
 * refuses an id that is not `[a-z0-9-]+`, so every real id is at least one character.
 */
export function machineKey(machine: { readonly id?: string }): string {
  return machine.id ?? "";
}

/**
 * Which machine each Bot came from, by `botId`.
 *
 * By bare id rather than by a composite key, and that is a measured property rather than a hope:
 * `botRegistry.ts` mints one with `crypto.randomUUID()`, so two registries that have never heard of
 * each other do not collide. The same is true of the session ids behind `source:sessionId`. That is
 * what lets every stored preference on this canvas -- the order, the detached sets, the open keys,
 * the card sizes -- keep working across machines untouched, and it is the single fact that makes
 * this a lookup instead of a rekeying of sixteen files.
 *
 * If a registry ever mints a non-random id, this is what breaks first, and it breaks by routing a
 * command at the wrong machine rather than by failing: key on `machine:botId` at that point.
 */
export function indexBotMachines(
  rosters: readonly { readonly machine: BotMachine; readonly bots: readonly BotView[] }[],
): ReadonlyMap<string, BotMachine> {
  const index = new Map<string, BotMachine>();
  for (const roster of rosters) {
    for (const bot of roster.bots) {
      // First writer wins, so a duplicate id cannot silently move a Bot's commands to another
      // machine mid-session; the order below is stable, so which one wins is stable too.
      if (!index.has(bot.botId)) index.set(bot.botId, roster.machine);
    }
  }
  return index;
}

/**
 * Which machine each attached SESSION is on, by `source:sessionId`.
 *
 * Derived from `sessionRefs` rather than from `sessions`, so a session the catalog has temporarily
 * lost still routes. Those resolve to `missingSessionRefs` rather than to a summary, and a card for
 * one is exactly the card whose menu a reader reaches for.
 *
 * Needed separately from `indexBotMachines` because several commands are addressed at a session and
 * never see a Bot: renaming one, and forking from its last message or last compaction, all take a
 * `SessionSummary` and post to a session endpoint. Sending those to the Mac for a session living on
 * a peer is the silent failure this whole module exists to prevent.
 */
export function indexSessionMachines(
  rosters: readonly { readonly machine: BotMachine; readonly bots: readonly BotView[] }[],
): ReadonlyMap<string, BotMachine> {
  const index = new Map<string, BotMachine>();
  for (const roster of rosters) {
    for (const bot of roster.bots) {
      for (const ref of bot.sessionRefs) {
        const key = `${ref.source}:${ref.sessionId}`;
        if (!index.has(key)) index.set(key, roster.machine);
      }
    }
  }
  return index;
}

/**
 * Every machine's Bots as one roster.
 *
 * The panel's own sidecar first and the rest by label, which is the order `indexFor` already puts
 * the session picker in: two lists of the same machines in two different orders is a reader
 * noticing the inconsistency before they notice anything else. Within a machine the snapshot's own
 * order is kept, because the canvas then applies the reader's stored arrangement over the top and a
 * second sort here would only decide the tie for Bots the reader has never moved.
 *
 * Rosters that have not arrived are simply absent. A machine that is down contributes nothing and
 * removes nothing, so a dead peer costs its own cards and leaves every other card where it was.
 */
export function mergeMachineBots(
  rosters: readonly { readonly machine: BotMachine; readonly bots: readonly BotView[] }[],
): BotView[] {
  const ordered = [...rosters].sort((a, b) => {
    const selfA = a.machine.id === undefined;
    const selfB = b.machine.id === undefined;
    if (selfA !== selfB) return selfA ? -1 : 1;
    return a.machine.label.localeCompare(b.machine.label);
  });
  const merged: BotView[] = [];
  const seen = new Set<string>();
  for (const roster of ordered) {
    for (const bot of roster.bots) {
      if (seen.has(bot.botId)) continue;
      seen.add(bot.botId);
      merged.push(bot);
    }
  }
  return merged;
}

/**
 * Whether the canvas is showing more than one machine, which is what decides whether a card says
 * which machine it is on.
 *
 * A single-machine panel is every panel until a peer is declared, and labelling every card "mac"
 * there is noise that tells the reader nothing they did not know.
 */
export function machinesAreMixed(machines: readonly BotMachine[]): boolean {
  return machines.length > 1;
}

/**
 * The Bots a hidden machine is not holding back.
 *
 * Shared rather than written twice, because two surfaces ask it and they have to agree: the canvas
 * draws exactly these cards, and the sidebar's canvas status says how many of the Bots on the
 * canvas they are. A copy of this filter in either place is how "7 of 8" comes to name a strip
 * holding six.
 *
 * A Bot no roster claims has no machine key, and is SHOWN: hiding a machine is a statement about
 * that machine, and an unplaceable Bot is not on it. Dropping it here would make it unreachable
 * through a control that never named it.
 */
export function botsOnShownMachines<T extends { botId: string }>(
  bots: readonly T[],
  hidden: ReadonlySet<string>,
  keyOfBot: (botId: string) => string | undefined,
): readonly T[] {
  if (hidden.size === 0) return bots;
  return bots.filter((bot) => !machineIsHidden(hidden, keyOfBot, bot.botId));
}

/**
 * Whether this Bot has no card because the machine it is on is hidden.
 *
 * The predicate the filter above is written in, exported because the sidebar roster asks it of one
 * Bot at a time rather than of a list: a row it marks is dimmed and its on-canvas control is
 * disabled, and those have to agree with the strip about which Bots those are.
 */
export function machineIsHidden(
  hidden: ReadonlySet<string>,
  keyOfBot: (botId: string) => string | undefined,
  botId: string,
): boolean {
  const key = keyOfBot(botId);
  return key !== undefined && hidden.has(key);
}

/**
 * Which sidecar each Bot command goes to.
 *
 * One object rather than a data source, because every command in the shell used to close over the
 * single `feed` and there is no longer a single answer. Passing the resolver instead of threading a
 * machine through twenty callbacks keeps the decision in one place, which is also the only place it
 * can be got wrong.
 */
export interface BotFeeds {
  /** The sidecar this panel runs beside. */
  readonly home: SidecarDataSource;
  /** Every machine the roster is read from, home first. */
  readonly machines: readonly BotMachine[];
  /** The sidecar that owns this Bot. */
  forBot(botId: string): SidecarDataSource;
  /** The sidecar that owns this session. */
  forSession(ref: BotSessionRef): SidecarDataSource;
  /** Every machine's Bots as they stand when called. */
  bots(): readonly BotView[];
}

export function botFeeds(
  home: SidecarDataSource,
  machines: readonly BotMachine[],
  machineOf: (botId: string) => BotMachine | undefined,
  machineOfSession: (ref: BotSessionRef) => BotMachine | undefined,
  bots: () => readonly BotView[],
): BotFeeds {
  return {
    home,
    machines,
    bots,
    forBot(botId) {
      const machine = machineOf(botId);
      // Thrown rather than defaulted to home, for the reason `requireBot` throws next door: every
      // Bot command is issued from a card that came out of a roster, so an id with no machine is a
      // bug here and not a reader's doing. Defaulting would send it at the Mac, where it comes back
      // as "no such Bot" -- a message about the wrong thing entirely. Every caller is inside a
      // try/catch that names the failure on the card that asked.
      if (!machine) throw new Error(`no machine holds the Bot "${botId}"`);
      return machine.feed;
    },
    forSession(ref) {
      // Home when nothing claims it, which is a real case rather than a fallback: the sidebar's
      // session list is this machine's inventory, and a session that is on no Bot at all is
      // addressed exactly the way it was before any of this existed.
      return machineOfSession(ref)?.feed ?? home;
    },
  };
}
