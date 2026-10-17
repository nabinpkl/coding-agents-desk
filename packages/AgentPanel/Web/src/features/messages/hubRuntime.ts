// Which runtime a recipient is, read from the directory rather than from a name.
//
// A destination is a Bot, so a Bot address carries no runtime. A session entry's `session` field
// carries it in the prefix (`claude:<id>`, `opencode:<id>`), and a Bot's runtime is whatever its
// members are. A Bot with no known members has no runtime to report, and this says so by returning
// nothing rather than guessing from the name.

import type { DirectoryEntry, MessageAddress } from "@agentdesk/agent-feed-wire";

/** The runtime a session runs on, or null when the entry is not a session. */
export function runtimeOf(entry: DirectoryEntry): string | null {
  if (!entry.session) return null;
  return entry.session.startsWith("claude:") ? "claude" : "opencode";
}

/**
 * Every runtime a recipient is reached through, in a stable order.
 *
 * A Bot holding both runtimes returns both, and the caller shows both badges rather than picking
 * one: the answer to "which runtime answers this" is genuinely both, and a Bot that looked like
 * one runtime would send a reader to a session that is not the one replying. One entry or many,
 * because most rows are a single session and a few are a Bot holding several.
 */
export function runtimesOf(entry: DirectoryEntry): string[];
export function runtimesOf(entries: DirectoryEntry[]): string[];
export function runtimesOf(input: DirectoryEntry | DirectoryEntry[]): string[] {
  const found = new Set<string>();
  for (const entry of Array.isArray(input) ? input : [input]) {
    const runtime = runtimeOf(entry);
    if (runtime) found.add(runtime);
  }
  return [...found].sort();
}

/** One pickable recipient, and the group it sits under. */
export interface RecipientGroup {
  /**
   * The whole path down to this group, `Top · Sub · Leaf`, because a `<select>` renders an
   * `<optgroup>` label as a single non-selectable line and cannot nest a second one inside it.
   * Spelling the path in the label is the only way the top level stays readable at a glance, and
   * the top level is the thing being asked for: which of these are Bots and which are sessions.
   */
  label: string;
  entries: DirectoryEntry[];
}

/** The two sections the picker is divided into. */
export const BOTS_SECTION = "All bots";
export const SESSIONS_SECTION = "All sessions";

/**
 * A group's entries with names that can be told apart inside that group.
 *
 * Two opencode sessions in one directory can carry the same title, and the hub's directory name is
 * that title, so without this the picker offers two rows that read identically. The id's tail is
 * what distinguishes them, and it is only added to the rows that actually collide: a name unique
 * in its group is left exactly as the hub spelled it.
 */
function distinctNames(entries: DirectoryEntry[]): DirectoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  if (![...counts.values()].some((count) => count > 1)) return entries;
  return entries.map((entry) =>
    (counts.get(entry.name) ?? 0) > 1
      ? { ...entry, name: `${entry.name} · ${entry.session!.split(":").pop()!.slice(-6)}` }
      : entry,
  );
}

/**
 * The recipient picker: one section per Bot, holding the sessions it curates.
 *
 * A Bot is the address, and a session is reachable only through the Bot that curates it, so the Bot
 * grouping is not decoration here, it is the whole of the address space. The hub does not list a
 * session in no Bot, so there is nothing else to show: a session the owner has not curated is not
 * something this picker could deliver to, and offering it would be a row that fails on use.
 *
 * Each row's `address` is the address that reaches that session, which the hub supplies: the Bot's
 * own address when it curates one session, and the qualified `bot:<id>/<sessionId>` when it curates
 * several. The picker hands that string to a send rather than assembling one, which is what keeps a
 * Bot with several sessions from being resolved to a session the reader did not choose.
 *
 * A session is identified by its machine and its directory rather than by its name, since two
 * opencode sessions can carry the same title on different machines and one title can be reused
 * inside a directory. Two directories on one machine whose last segment matches grow a segment to
 * be told apart, which is what splits `projects/tmp` from `/private/tmp`.
 */
export function recipientGroups(directory: DirectoryEntry[]): RecipientGroup[] {
  const sessions = directory.filter((entry) => entry.session !== null);
  const byBot = new Map<MessageAddress, DirectoryEntry[]>();
  for (const entry of sessions) {
    const bot = entry.related[0];
    if (!bot) continue;
    byBot.set(bot, [...(byBot.get(bot) ?? []), entry]);
  }
  const names = new Map(directory.filter((e) => e.address.startsWith("bot:")).map((e) => [e.address, e.name]));
  const groups: RecipientGroup[] = [];
  for (const [bot, members] of byBot) {
    const label = names.get(bot) ?? bot.slice("bot:".length);
    groups.push({ label: `${BOTS_SECTION} · ${label}`, entries: distinctNames(members) });
  }
  return groups;
}
