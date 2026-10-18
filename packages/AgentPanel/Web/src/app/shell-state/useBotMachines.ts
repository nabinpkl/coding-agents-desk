// The machine dimension of the shell, in one place.
//
// A Bot is a directory and the sessions working in it, and that directory does not have to be on
// the machine the panel runs beside: `tools/remote-sidecar.sh` puts an agent-feed sidecar on an ssh
// peer, `AGENTDESK_PANEL_REMOTE_SIDECARS` declares it, and the dev server proxies to it. Which Bot
// lives where, and therefore which sidecar answers for it, is what this owns. `botMachines.ts`
// carries why the Bot RECORD stays on its own machine rather than being copied here.
//
// It is one hook rather than five values in the shell because they are one decision made five
// times: the roster, the command routing, the window composers, the label on a card and the context
// a card's session renders in are each "which sidecar is this Bot's". Spread across the shell, the
// failure is that one of them is missed -- which is exactly what happened while this was being
// built: the commands were routed and the transcript was not, so a peer's card ran its menu against
// the right sidecar and read its transcript from the wrong one.

import { useMemo } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import {
  sidecarWindowComposerClient,
  type WindowComposerClient,
} from "@/features/window-composer/WindowComposerClient";
import { botFeeds, machineKey, machinesAreMixed, type BotFeeds, type BotMachine } from "@/features/bots/botMachines";
import { useBots, type BotRosterState } from "@/features/bots/useBots";
import type { SessionViewContext } from "@/features/session-view/SessionView";

/** One machine's pair of window composers. Bound to a source, so shared across its sessions. */
export interface MachineComposers {
  claude: WindowComposerClient;
  codex: WindowComposerClient;
}

export interface ShellMachines {
  /** Every machine the canvas reads, home first. Never empty. */
  readonly all: readonly BotMachine[];
  /** Every machine's Bots as one roster, and which machine each is on. */
  readonly roster: BotRosterState;
  /** Which sidecar each Bot command goes to. */
  readonly feeds: BotFeeds;
  /** The window composers for the machine this shell is pointed at. */
  readonly composers: MachineComposers;
  /** Which machine to write on each card, by Bot id, and empty when there is only one. */
  readonly labels: ReadonlyMap<string, string>;
  /**
   * The machines a reader can show or hide on the canvas, and EMPTY when there is only one.
   *
   * Keys rather than the machines themselves, because what a chip does is filter and what a filter
   * is stored as is a key: `machineKey` is the id the dev server routes by, so a remembered choice
   * keeps meaning the same machine when a peer is relabelled.
   */
  readonly chips: readonly { key: string; label: string }[];
  /** Which machine each Bot is on, as the key its chip carries. Changes with the roster. */
  readonly machineKeys: ReadonlyMap<string, string>;
  /** Which machine a Bot is on, as the key its chip carries. */
  keyOfBot(botId: string): string | undefined;
  /**
   * The sidecar a rendered Bot belongs to, as of this render. `feeds.forBot` answers the same for a
   * command, but from the roster as last committed, which a Bot that arrived in this render is not
   * in yet.
   */
  feedOfBot(botId: string): SidecarDataSource;
  /**
   * Whether the set of machines is KNOWN, as opposed to not having arrived.
   *
   * The distinction the fallback below erases, and it is load-bearing for anything that drops
   * stored state against the roster. An embedder that names no machines at all (the host's webview,
   * which reaches one sidecar through a relay and has no index to read) knows there is one; the
   * browser shell's first render also names none, and knows nothing -- its live index is a moment
   * behind the mount.
   *
   * Measured, not reasoned: with this conflated, `useCanvasRoster` saw a settled single-machine
   * roster on the first render and pruned every open card belonging to a peer that was about to
   * appear. One reload removed an oracle session from the canvas permanently, and the stored set
   * showed exactly that key missing while this machine's six survived.
   */
  readonly known: boolean;
  /**
   * One card's session context, pointed at the machine that owns its Bot.
   *
   * Takes the shell's own context rather than building one, because that context carries a dozen
   * reader preferences this hook has no business knowing. All it changes is where the session is
   * read from and whose windows it composes into.
   */
  contextFor(base: SessionViewContext, botId: string): SessionViewContext;
}

export function useBotMachines(
  /** The sidecar this shell is pointed at, which the session picker may have moved to a peer. */
  feed: SidecarDataSource,
  /** Every machine the embedder can reach, or absent for one that reaches only its own. */
  machines: readonly BotMachine[] | undefined,
): ShellMachines {
  // One machine, unlabelled, when the embedder names none -- and when it names none YET. An empty
  // list is the ordinary first render in the browser shell, where the live index arrives a moment
  // after mount, and treating it as "no machines" would leave the canvas subscribed to nothing and
  // loading forever. `machinesAreMixed` is false for one, so nothing says which machine anything is
  // on and the panel is what it always was.
  const all = useMemo<readonly BotMachine[]>(
    () => (machines && machines.length > 0 ? machines : [{ label: "this machine", feed }]),
    [machines, feed],
  );
  const roster = useBots(all);
  // Identity-stable, because `machineOf` and `machineOfSession` are: every command callback in the
  // shell closes over this, and a new object on each Bot-stream push would rebuild all of them.
  const feeds = useMemo(
    () => botFeeds(feed, all, roster.machineOf, roster.machineOfSession, roster.botsNow),
    [feed, all, roster.machineOf, roster.machineOfSession, roster.botsNow],
  );

  /**
   * One window composer pair per machine.
   *
   * Both composers are served by the sidecar and the standalone helper (ADR-0110). One client per
   * source, because the two resolve their window differently -- Claude by its process tree, Codex by
   * its own state joined to its accessibility tree -- and the sidecar is told which to run rather
   * than guessing. They are bound to a source rather than to a session, so they outlive any of them.
   *
   * A peer gets its OWN pair rather than this machine's. Typing into another application's text
   * field is something a sidecar does on the machine it runs on, so pointing a peer's session at
   * this Mac's composer would drive whatever Claude window happens to be open here -- the wrong
   * session, on the wrong machine, with no error. A peer with no window manager refuses instead,
   * which is the honest answer (`/api/config` already says `parkAvailable: false` for that reason).
   */
  const composersByMachine = useMemo(() => {
    const byMachine = new Map<string, MachineComposers>();
    for (const machine of all) {
      byMachine.set(machineKey(machine), {
        claude: sidecarWindowComposerClient(machine.feed, "claude"),
        codex: sidecarWindowComposerClient(machine.feed, "codex"),
      });
    }
    return byMachine;
  }, [all]);
  const composers = useMemo(
    () => ({
      claude: sidecarWindowComposerClient(feed, "claude"),
      codex: sidecarWindowComposerClient(feed, "codex"),
    }),
    [feed],
  );

  /**
   * Which machine to write on each card, and empty while there is only one to be on.
   *
   * Over the whole roster rather than the cards on the canvas, for the reason `botCanvasHues` is:
   * this is a fact about a Bot, not about what is currently on screen.
   */
  const index = roster.machineIndex;
  const labels = useMemo(() => {
    const byBot = new Map<string, string>();
    if (!machinesAreMixed(all)) return byBot;
    for (const bot of roster.bots) {
      const label = index.bot.get(bot.botId)?.label;
      if (label) byBot.set(bot.botId, label);
    }
    return byBot;
  }, [all, roster.bots, index]);
  const machineKeys = useMemo(
    () => new Map([...index.bot].map(([botId, machine]) => [botId, machineKey(machine)])),
    [index],
  );
  const chips = useMemo(
    () => (machinesAreMixed(all) ? all.map((machine) => ({ key: machineKey(machine), label: machine.label })) : []),
    [all],
  );

  return {
    all,
    roster,
    feeds,
    composers,
    labels,
    chips,
    machineKeys,
    keyOfBot(botId) {
      return machineKeys.get(botId);
    },
    feedOfBot(botId) {
      const machine = index.bot.get(botId);
      // Thrown for the reason `botFeeds.forBot` throws: a rendered Bot came out of this roster.
      if (!machine) throw new Error(`no machine holds the Bot "${botId}"`);
      return machine.feed;
    },
    known: machines === undefined || machines.length > 0,
    contextFor(base, botId) {
      const machine = index.bot.get(botId);
      // The shell's own context when the Bot is on the machine the shell is pointed at, so the
      // ordinary single-machine panel hands every card the same object it always did.
      //
      // And the same for a Bot no roster claims, which is the choice `botFeeds.forSession` makes for
      // a session on no Bot. It cannot be reached from a rendered card anyway: a card exists
      // because a roster produced it.
      if (!machine || machine.feed === feed) return base;
      return {
        ...base,
        feed: machine.feed,
        windowComposers: composersByMachine.get(machineKey(machine)) ?? composers,
      };
    },
  };
}
