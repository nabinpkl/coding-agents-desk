import { Unlink } from "lucide-react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { RowMenu } from "./RowMenu";

/**
 * The actions menu on a Bot's card header, for the things that are done to the whole Bot rather
 * than to one of its sessions.
 *
 * One entry today, and it is the canvas's own: taking a Bot off the canvas arranges this view and
 * changes nothing about the Bot. The Bots tab still lists it, its sessions are still curated, and
 * the sidebar's canvas panel is where it waits to be put back.
 */
export function BotCardMenu({ bot, onDetach }: { bot: BotView; onDetach: () => void }) {
  return (
    <RowMenu
      label={bot.name}
      items={[{ label: "Remove from canvas", icon: Unlink, onSelect: onDetach }]}
    />
  );
}
