// Who can be addressed, and which session a Bot address lands on right now.

import { basename } from "node:path";
import type { DirectoryEntry, MessageAddress, MessagingSource } from "@agentdesk/agent-feed-wire";
import type { BotRow, HubStore, SessionRow } from "@/store";

/** Offline sessions older than this drop out of the listing; their messages stay. */
const OFFLINE_LISTING_MS = 7 * 24 * 3600 * 1000;

export const HUMAN_NAME = "owner";

export const SESSION_ID = /^[0-9a-zA-Z_-]{1,128}$/;

/** The sources a session stream can be opened for, with the address prefix each one uses. */
const SOURCE_PREFIX: Record<MessagingSource, string> = { claude: "claude", opencode: "opencode" };

export function isAddress(value: unknown): value is MessageAddress {
  return (
    typeof value === "string" &&
    (value === "human" ||
      /^(claude|opencode):[0-9a-zA-Z_-]{1,128}$/.test(value) ||
      /^bot:[A-Za-z0-9_.:-]{1,128}$/.test(value))
  );
}

/** A true session address, or null. Bot and human addresses are not session addresses. */
export function sessionAddress(value: unknown): MessageAddress | null {
  if (typeof value !== "string") return null;
  for (const [source, prefix] of Object.entries(SOURCE_PREFIX)) {
    if (value.startsWith(`${prefix}:`) && SESSION_ID.test(value.slice(prefix.length + 1))) {
      return `${source}:${value.slice(prefix.length + 1)}` as MessageAddress;
    }
  }
  return null;
}

export function sessionSource(address: MessageAddress): MessagingSource | null {
  if (address.startsWith("claude:")) return "claude";
  if (address.startsWith("opencode:")) return "opencode";
  return null;
}

export function botAddress(bot: BotRow): MessageAddress {
  return `bot:${bot.botId}`;
}

function sessionName(s: SessionRow): string {
  return s.title || basename(s.cwd) || s.address;
}

export class Directory {
  constructor(private readonly store: HubStore) {}

  /** The Bots a session belongs to. */
  botsOf(address: MessageAddress): BotRow[] {
    if (!sessionSource(address)) return [];
    return this.store.bots().filter((bot) => bot.sessionIds.includes(address));
  }

  bot(address: MessageAddress): BotRow | undefined {
    if (!address.startsWith("bot:")) return undefined;
    const botId = address.slice("bot:".length);
    return this.store.bots().find((bot) => bot.botId === botId);
  }

  exists(address: MessageAddress): boolean {
    if (address === "human") return true;
    if (address.startsWith("bot:")) return this.bot(address) !== undefined;
    return this.store.getSession(address) !== undefined;
  }

  reachable(address: MessageAddress): boolean {
    const s = this.store.getSession(address);
    return s !== undefined && s.connected && s.channel;
  }

  /** The newest reachable member session of a Bot, or null when none is. */
  resolveBot(address: MessageAddress): MessageAddress | null {
    const bot = this.bot(address);
    if (!bot) return null;
    const members = new Set(bot.sessionIds);
    const live = this.store.sessions().filter((s) => members.has(s.address) && s.connected && s.channel);
    return live[0]?.address ?? null;
  }

  nameOf(address: MessageAddress): string {
    if (address === "human") return HUMAN_NAME;
    if (address.startsWith("bot:")) return this.bot(address)?.name ?? address;
    const session = this.store.getSession(address);
    if (!session) return address;
    const bots = this.botsOf(address);
    return bots.length > 0 ? `${bots[0]!.name} (${sessionName(session)})` : sessionName(session);
  }

  list(now: number): DirectoryEntry[] {
    const sessions = this.store.sessions();
    const bots = this.store.bots();
    const byAddress = new Map(sessions.map((s) => [s.address, s]));
    const entries: DirectoryEntry[] = [{
      address: "human",
      name: HUMAN_NAME,
      machine: null,
      reachability: "reachable",
      lastSeenAt: null,
      related: [],
      cwd: null,
    }];
    for (const bot of bots) {
      const members = bot.sessionIds.map((id) => byAddress.get(id as MessageAddress)).filter((s): s is SessionRow => s !== undefined);
      entries.push({
        address: botAddress(bot),
        name: bot.name,
        machine: bot.machine,
        reachability: members.some((s) => s.connected && s.channel) ? "reachable" : members.some((s) => s.connected) ? "no-channel" : "offline",
        lastSeenAt: bot.publishedAt,
        related: members.map((s) => s.address),
        cwd: bot.path,
      });
    }
    for (const s of sessions) {
      if (!s.connected && now - Date.parse(s.lastSeen) > OFFLINE_LISTING_MS) continue;
      entries.push({
        address: s.address,
        name: sessionName(s),
        machine: s.machine,
        reachability: s.connected ? (s.channel ? "reachable" : "no-channel") : "offline",
        lastSeenAt: s.lastSeen,
        related: bots.filter((b) => b.sessionIds.includes(s.address)).map(botAddress),
        cwd: s.cwd,
      });
    }
    return entries;
  }
}
