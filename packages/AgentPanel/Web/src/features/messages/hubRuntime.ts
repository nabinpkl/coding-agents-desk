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
  /** The Bot's name, or the machine and directory a loose session runs in. */
  label: string;
  entries: DirectoryEntry[];
}

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
      ? { ...entry, name: `${entry.name} · ${entry.address.split(":").pop()!.slice(-6)}` }
      : entry,
  );
}

/**
 * The recipient picker: Bot members under the Bot, everything else under where it runs.
 *
 * A Bot is not something you can talk to. The hub resolves `bot:<id>` to whichever member session
 * is live at delivery time, so picking a Bot picks a session by a rule the reader cannot see, and
 * two Bots whose sessions overlap are indistinguishable. The Bot's name is therefore only a group
 * label here, and the options under it are the sessions that will actually receive the message.
 *
 * A loose session is identified by its machine and its directory, not by its name: two opencode
 * sessions can carry the same title on different machines, and one title can be reused inside a
 * directory. A `<select>` nests one level of `<optgroup>`, so the heading carries the machine and
 * the directory and the option carries the name, rather than printing the path on every row.
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
    groups.push({ label: bot.name, entries: distinctNames(members) });
  }

  const loose = sessions.filter((entry) => !claimed.has(entry.address));
  groups.push(...looseGroups(loose));
  return groups;
}

/** The last path segment, with the one above it when two directories in a machine share a name. */
function pathLabels(paths: readonly string[]): Map<string, string> {
  const byBasename = new Map<string, string[]>();
  for (const path of paths) {
    const base = path.split("/").filter(Boolean).pop() ?? path;
    byBasename.set(base, [...(byBasename.get(base) ?? []), path]);
  }
  const labels = new Map<string, string>();
  for (const [base, sharing] of byBasename) {
    for (const path of sharing) {
      const segments = path.split("/").filter(Boolean);
      // A home directory is recognisable from the path alone on both platforms: `/Users/<name>`
      // and `/home/<name>`. Saying "home" rather than the last segment matters because that
      // segment is the reader's own name, and a heading that names the reader instead of the place
      // is worse than no heading. The check is on the second segment rather than on the length,
      // because `/work/other` is two segments long and is not anybody's home.
      if (segments.length === 2 && (segments[0] === "Users" || segments[0] === "home")) {
        labels.set(path, "home");
        continue;
      }
      if (sharing.length === 1) {
        labels.set(path, base);
        continue;
      }
      // Two `tmp` directories on one machine: one more segment up is what tells them apart, and
      // it is still short enough to read as a heading.
      labels.set(path, segments.slice(Math.max(0, segments.length - 2)).join("/"));
    }
  }
  return labels;
}

/** Loose sessions, one group per machine and directory, in a stable order. */
function looseGroups(loose: DirectoryEntry[]): RecipientGroup[] {
  if (loose.length === 0) return [];
  const byMachine = new Map<string, DirectoryEntry[]>();
  for (const entry of loose) {
    const machine = entry.machine ?? "unknown machine";
    byMachine.set(machine, [...(byMachine.get(machine) ?? []), entry]);
  }
  const groups: RecipientGroup[] = [];
  for (const machine of [...byMachine.keys()].sort()) {
    const entries = byMachine.get(machine)!;
    const labels = pathLabels(entries.map((entry) => entry.cwd ?? ""));
    const byDirectory = new Map<string, DirectoryEntry[]>();
    for (const entry of entries) {
      const directory = entry.cwd ?? "";
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), entry]);
    }
    for (const directory of [...byDirectory.keys()].sort()) {
      groups.push({
        label: `${machine} · ${labels.get(directory) ?? directory}`,
        entries: distinctNames(byDirectory.get(directory)!),
      });
    }
  }
  return groups;
}
