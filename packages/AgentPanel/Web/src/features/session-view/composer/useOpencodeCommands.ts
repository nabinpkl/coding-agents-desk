/**
 * An opencode session's slash commands, fetched once and filtered locally.
 *
 * The tmux band mirrors a menu the pane owns; an opencode session has no pane, so the panel
 * owns this list outright: one GET when the composer opens, then the draft filters it without
 * another round trip. A failed fetch is an empty list rather than an error -- the field keeps
 * sending text, which is what the composer was before commands existed.
 *
 * The list itself is not written here. The sidecar mirrors opencode's web client
 * (`packages/app` at v2.0.16) and merges in the serve's own custom commands, so this file only
 * decides what the menu shows of it and what a typed draft resolves to.
 */

import { useEffect, useState } from "react";
import type { ComposerCommand } from "@agentdesk/agent-feed-wire";
import type { OpencodeSlashCommand } from "@/features/activity-feed/data-source/SidecarAgentSessions";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

export type { OpencodeSlashCommand };

export function useOpencodeCommands(
  feed: SidecarDataSource,
  session: { source: string; sessionId: string } | null,
): readonly OpencodeSlashCommand[] {
  const [commands, setCommands] = useState<readonly OpencodeSlashCommand[]>([]);
  const source = session?.source;
  const sessionId = session?.sessionId;
  useEffect(() => {
    if (source !== "opencode" || !sessionId) return;
    let live = true;
    feed.listOpencodeCommands().then(
      (list) => {
        if (live) setCommands(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [feed, source, sessionId]);
  return commands;
}

/**
 * The picker's rows for this draft, and the rule for when there are any at all.
 *
 * Only while the draft opens with a slash and spells nothing else: `/^\/(\S*)$/`, which is the
 * web client's own test (`packages/app/src/composer/suggestions/machine.ts`). It is what makes
 * Return mean one thing. While the menu is open the reader is choosing a name, so Return takes
 * the highlighted row; the moment the draft carries an argument the menu is gone, so Return is
 * a submit -- the same thing the Send button does. An earlier version kept filtering on the
 * first token, which left the menu open after `/compact ` was completed and forced an exactness
 * test to tell "still choosing" from "already named".
 *
 * A name matches by any of its spellings, so `/models` finds the `model` row. Shaped as
 * `ComposerCommand` so the band draws the same list the pane's menu gets, with nothing in the
 * band knowing where either came from.
 */
export function opencodeCommandRows(
  commands: readonly OpencodeSlashCommand[],
  draft: string,
): readonly ComposerCommand[] {
  const typed = /^\/(\S*)$/.exec(draft);
  if (!typed) return [];
  const prefix = (typed[1] ?? "").toLowerCase();
  return commands
    .filter((command) => commandNames(command).some((name) => name.startsWith(prefix)))
    .map((command, index) => ({
      name: `/${command.name}`,
      description: command.description ?? "",
      selected: index === 0,
    }));
}

/** Every spelling of a command, canonical first: its name and then its aliases. */
function commandNames(command: OpencodeSlashCommand): readonly string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

/** A draft that names a listed command, split into the command and its arguments. */
export function parseOpencodeCommand(
  commands: readonly OpencodeSlashCommand[],
  draft: string,
): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_-]+)([\s\S]*)$/.exec(draft.trim());
  if (!match) return null;
  const typed = match[1]!.toLowerCase();
  // The catalogue name, whatever the reader typed: `/models` runs the `model` row, which is the
  // one thing the shell routes to the model dialog.
  const command = commands.find((entry) => commandNames(entry).includes(typed));
  if (!command) return null;
  return { name: command.name, args: (match[2] ?? "").trim() };
}
