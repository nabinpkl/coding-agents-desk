// Which runtime a hub address is, read from the address rather than from a name.
//
// A session address carries it in the prefix (`claude:<id>`, `opencode:<id>`). A Bot address does
// not, because a Bot may hold sessions from both: the directory entry's `related` list is its
// member sessions, so a Bot's runtime is whatever its members are. A Bot with no known members has
// no runtime to report, and this says so by returning nothing rather than guessing from the name.

import type { DirectoryEntry, MessageAddress } from "@agentdesk/agent-feed-wire";

/** The runtime an address names, or null when the address names none. */
export function runtimeOf(address: MessageAddress): string | null {
  if (address.startsWith("claude:")) return "claude";
  if (address.startsWith("opencode:")) return "opencode";
  return null;
}

/**
 * Every runtime a recipient is reached through, in a stable order.
 *
 * A Bot holding both runtimes returns both, and the caller shows both badges rather than picking
 * one: the answer to "which runtime answers this" is genuinely both, and a Bot that looked like
 * one runtime would send a reader to a session that is not the one replying.
 */
export function runtimesOf(entry: DirectoryEntry): string[] {
  const direct = runtimeOf(entry.address);
  if (direct) return [direct];
  const fromMembers = new Set<string>();
  for (const member of entry.related) {
    const runtime = runtimeOf(member);
    if (runtime) fromMembers.add(runtime);
  }
  return [...fromMembers].sort();
}

/** One pickable recipient, and the group it sits under. */
export interface RecipientGroup {
  /**
   * The Bot's name, or null for a session that belongs to no Bot. Null rather than a word here,
   * because "belongs to no Bot" is a fact and "Sessions" is a heading the caller words; this
   * module decides who is under what, not what the column above them is called.
   */
  label: string | null;
  entries: DirectoryEntry[];
}

/**
 * The recipient picker, grouped by the Bot a session belongs to.
 *
 * A Bot is not something you can talk to. The hub resolves `bot:<id>` to whichever member session
 * is live at delivery time, so picking a Bot picks a session by a rule the reader cannot see, and
 * two Bots whose sessions overlap are indistinguishable. The Bot's name is therefore only a group
 * label here, and the options under it are the sessions that will actually receive the message.
 *
 * Loose sessions come last under their own heading, so a session with no Bot is still one click
 * away and the list of everything reachable is still one list.
 */
export function recipientGroups(directory: DirectoryEntry[]): RecipientGroup[] {
  const byAddress = new Map(directory.map((entry) => [entry.address, entry]));
  const sessions = directory.filter((entry) => runtimeOf(entry.address) !== null);
  const claimed = new Set<string>();
  const groups: RecipientGroup[] = [];

  for (const bot of directory.filter((entry) => entry.address.startsWith("bot:"))) {
    const members = bot.related
      .map((address) => byAddress.get(address))
      .filter(
        (entry): entry is DirectoryEntry =>
          entry !== undefined && runtimeOf(entry.address) !== null && !claimed.has(entry.address),
      );
    if (members.length === 0) continue;
    for (const member of members) claimed.add(member.address);
    groups.push({ label: bot.name, entries: members });
  }

  const loose = sessions.filter((entry) => !claimed.has(entry.address));
  if (loose.length > 0) groups.push({ label: null, entries: loose });
  return groups;
}
