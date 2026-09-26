// Who can be addressed, and how a Bot's name becomes one session.
//
// A Bot is the unit of curation and the only thing a message can be addressed to. Addressing
// `bot:<id>` is enough when the Bot has exactly one session; a Bot with several does not say which
// of them should receive a message, so it takes `bot:<id>/<sessionId>` and the session has to be one
// of its members. Guessing instead is how an instruction lands in the wrong agent, which is the
// failure this shape exists to remove. A session in no Bot is not addressable at all, by anyone.

import { basename } from "node:path";
import type { DirectoryEntry, MessageAddress, MessagingSource, SessionAddress } from "@agentdesk/agent-feed-wire";
import type { BotRow, HubStore, SessionRow } from "@/store";

/** Offline sessions older than this drop out of the listing; their messages stay. */
const OFFLINE_LISTING_MS = 7 * 24 * 3600 * 1000;

export const HUMAN_NAME = "owner";

export const SESSION_ID = /^[0-9a-zA-Z_-]{1,128}$/;

/** The sources a session stream can be opened for, with the address prefix each one uses. */
const SOURCE_PREFIX: Record<MessagingSource, string> = { claude: "claude", opencode: "opencode" };

const BOT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Whether a value is an address: the owner, or a Bot, optionally naming which of its sessions.
 *
 * A bare session address is deliberately not one. A session is reachable through the Bot it belongs
 * to, so the only way to name one is through that Bot, and an address cannot exist that names a
 * session outside the Bot it claims.
 */
export function isAddress(value: unknown): value is MessageAddress {
  if (value === "human") return true;
  if (typeof value !== "string") return false;
  return parseAddress(value) !== null;
}

interface ParsedAddress {
  botId: string;
  /** The session named within the Bot, or null when the address names the Bot alone. */
  sessionId: string | null;
}

/** A Bot address and the session it names, or null when the value is not one. */
function parseAddress(value: string): ParsedAddress | null {
  if (!value.startsWith("bot:")) return null;
  const rest = value.slice("bot:".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return BOT_ID.test(rest) ? { botId: rest, sessionId: null } : null;
  const botId = rest.slice(0, slash);
  const sessionId = rest.slice(slash + 1);
  if (!BOT_ID.test(botId) || !SESSION_ID.test(sessionId)) return null;
  return { botId, sessionId };
}

/** A true session address, or null. Bot and human addresses are not session addresses. */
export function sessionAddress(value: unknown): SessionAddress | null {
  if (typeof value !== "string") return null;
  for (const [source, prefix] of Object.entries(SOURCE_PREFIX)) {
    if (value.startsWith(`${prefix}:`) && SESSION_ID.test(value.slice(prefix.length + 1))) {
      return `${source}:${value.slice(prefix.length + 1)}` as SessionAddress;
    }
  }
  return null;
}

export function sessionSource(address: string): MessagingSource | null {
  if (address.startsWith("claude:")) return "claude";
  if (address.startsWith("opencode:")) return "opencode";
  return null;
}

export function botAddress(bot: BotRow): MessageAddress {
  return `bot:${bot.botId}` as MessageAddress;
}

/** The address that reaches one member session of a Bot, used by the surfaces that offer a choice. */
export function memberAddress(bot: BotRow, session: SessionAddress): MessageAddress {
  return `bot:${bot.botId}/${session.slice(session.indexOf(":") + 1)}` as MessageAddress;
}


function sessionName(s: SessionRow): string {
  return s.title || basename(s.cwd) || s.address;
}

export class Directory {
  constructor(private readonly store: HubStore) {}

  /** The Bots a session belongs to. */
  /** The Bots a session belongs to. A session can be in more than one, and each is a curation. */
  botsOf(address: string): BotRow[] {
    if (!sessionSource(address)) return [];
    return this.store.bots().filter((bot) => bot.sessionIds.includes(address));
  }

  /** The session an address names, or null when it names none. Accepts a session address too. */
  sessionOf(address: string): SessionAddress | null {
    return sessionAddress(address) ?? this.namedSession(address);
  }

  /** The Bot a member address names, or undefined. An address that is not one gives undefined. */
  bot(address: string): BotRow | undefined {
    const parsed = parseAddress(address);
    if (!parsed) return undefined;
    return this.store.bots().find((bot) => bot.botId === parsed.botId);
  }

  /** The session an address names within its Bot, or null when it names the Bot alone. */
  namedSession(address: string): SessionAddress | null {
    const parsed = parseAddress(address);
    if (!parsed?.sessionId) return null;
    const bot = this.store.bots().find((b) => b.botId === parsed.botId);
    if (!bot) return null;
    // The Bot decides which prefix a member id carries, since it published that list.
    const match = bot.sessionIds.find((id) => id.endsWith(`:${parsed.sessionId}`) || id === parsed.sessionId);
    return (match as SessionAddress | undefined) ?? null;
  }

  /** The sessions a Bot curates, in the order it published them. */
  membersOf(bot: BotRow): SessionAddress[] {
    return bot.sessionIds.filter((id): id is SessionAddress => sessionAddress(id) !== null);
  }

  reachable(address: SessionAddress): boolean {
    const s = this.store.getSession(address);
    return s !== undefined && s.connected && s.channel;
  }

  nameOf(address: string): string {
    if (address === "human") return HUMAN_NAME;
    const bot = this.bot(address);
    if (bot) return bot.name;
    const session = this.store.getSession(address as SessionAddress);
    if (!session) return address;
    const bots = this.botsOf(address);
    return bots.length > 0 ? `${bots[0]!.name} (${sessionName(session)})` : sessionName(session);
  }

  /**
   * Who exists for messaging: the owner, and the sessions some Bot curates.
   *
   * A session in no Bot is not listed, because it is not addressable by anyone. Listing it would
   * offer a choice that cannot be taken, and the whole point of the Bot grouping is that the owner
   * curates which agents take part, so an uncurated session staying visible would be the noise the
   * grouping removes. The panel and the annotator both read this list, so neither can offer one.
   *
   * Each session entry's `address` is the address that reaches it, `bot:<id>` when its Bot curates
   * one session and `bot:<id>/<session>` when it curates several, so a surface hands the address
   * straight to a send rather than assembling one and getting it subtly wrong.
   */
  list(now: number): DirectoryEntry[] {
    const sessions = this.store.sessions();
    const bots = this.store.bots();
    const byAddress = new Map(sessions.map((s) => [s.address, s]));
    const entries: DirectoryEntry[] = [{
      address: "human",
      session: null,
      name: HUMAN_NAME,
      machine: null,
      reachability: "reachable",
      lastSeenAt: null,
      related: [],
      cwd: null,
    }];
    for (const bot of bots) {
      const members = this.membersOf(bot);
      const rows = members.map((id) => byAddress.get(id)).filter((s): s is SessionRow => s !== undefined);
      entries.push({
        address: botAddress(bot),
        session: null,
        name: bot.name,
        machine: bot.machine,
        reachability: rows.some((s) => s.connected && s.channel) ? "reachable" : rows.some((s) => s.connected) ? "no-channel" : "offline",
        lastSeenAt: bot.publishedAt,
        // The qualified address of each member, which is what reaches it. A Bot curating one session
        // is reachable by its own name too, and `related` naming the qualified form keeps one shape
        // here whatever the Bot's size.
        related: members.map((id) => memberAddress(bot, id)),
        cwd: bot.path,
      });
    }
    for (const bot of bots) {
      for (const id of this.membersOf(bot)) {
        const s = byAddress.get(id);
        if (!s) continue;
        if (!s.connected && now - Date.parse(s.lastSeen) > OFFLINE_LISTING_MS) continue;
        entries.push({
          // Always the qualified form, even for a Bot curating one session. A single-session Bot's own
          // address is the address that reaches it, and a session entry carrying the same string would
          // collide with the Bot's entry in anything that looks a recipient up by address -- which is
          // how a session row went missing and a send reported the Bot's name instead of the session's.
          address: memberAddress(bot, id),
          session: id,
          name: sessionName(s),
          machine: s.machine,
          reachability: s.connected ? (s.channel ? "reachable" : "no-channel") : "offline",
          lastSeenAt: s.lastSeen,
          related: [botAddress(bot)],
          cwd: s.cwd,
        });
      }
    }
    return entries;
  }
}
