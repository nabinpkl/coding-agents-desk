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
