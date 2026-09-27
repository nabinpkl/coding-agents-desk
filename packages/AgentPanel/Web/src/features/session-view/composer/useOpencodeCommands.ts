/**
 * An opencode session's slash commands, fetched once and filtered locally.
 *
 * The tmux band mirrors a menu the pane owns; an opencode session has no pane, so the panel
 * owns this list outright: one GET when the composer opens, then the draft filters it without
 * another round trip. A failed fetch is an empty list rather than an error -- the field keeps
 * sending text, which is what the composer was before commands existed.
 */

import { useEffect, useState } from "react";
import type { ComposerCommand } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

export interface OpencodeSlashCommand {
  name: string;
  description?: string;
}

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
 * The panel-owned entry the serve never lists: opening the model picker. Appended after the
 * served commands so a name collision -- today there is none -- would keep the serve's
 * meaning and the dialog stays reachable by typing past it.
 */
export const MODELS_COMMAND: OpencodeSlashCommand = {
  name: "models",
  description: "Switch this session's model",
};

/**
 * The picker's rows for this draft: only while it opens with a slash, filtered by the name
 * being typed, first match carrying Return. Shaped as `ComposerCommand` so the band draws the
 * same list the pane's menu gets, with nothing in the band knowing where either came from.
 */
export function opencodeCommandRows(
  commands: readonly OpencodeSlashCommand[],
  draft: string,
): readonly ComposerCommand[] {
  if (!draft.startsWith("/")) return [];
  const prefix = draft.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  const matches = [...commands, MODELS_COMMAND].filter((command) => command.name.toLowerCase().startsWith(prefix));
  return matches.map((command, index) => ({
    name: `/${command.name}`,
    description: command.description ?? "",
    selected: index === 0,
  }));
}

/**
 * Whether the draft already names this command, so Return should run it rather than complete it.
 *
 * The same first token `opencodeCommandRows` filters on, which is the whole point: the picker
 * keeps matching after it completes (`/compact` becomes `/compact `, and the token is still
 * `compact`), so a Return that always completed could never run anything. Comparing the token
 * the filter reads is what tells "still choosing" from "already named".
 */
export function draftNamesCommand(draft: string, name: string): boolean {
  if (!draft.startsWith("/")) return false;
  const token = draft.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  return token === name.replace(/^\//, "").toLowerCase();
}

/** A draft that names a listed command, split into the command and its arguments. */
export function parseOpencodeCommand(
  commands: readonly OpencodeSlashCommand[],
  draft: string,
): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_-]+)([\s\S]*)$/.exec(draft.trim());
  if (!match) return null;
  const name = match[1]!;
  if (![...commands, MODELS_COMMAND].some((command) => command.name === name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}
