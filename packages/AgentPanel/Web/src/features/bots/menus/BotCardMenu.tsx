import { ArrowLeft, ArrowRight, Unlink } from "lucide-react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { RowMenu } from "@/features/bots/menus/RowMenu";

/**
 * The actions menu on a Bot's card header, for the things that are done to the whole Bot rather
 * than to one of its sessions.
 *
 * Two kinds of entry, and both are the canvas's own rather than the Bot's. Taking a Bot off the
 * canvas arranges this view and changes nothing about the Bot: the Bots tab still lists it, its
 * sessions are still curated, and the sidebar's canvas panel is where it waits to be put back.
 * Moving it left or right is the keyboard's way to the same thing the header drag does, and it
 * exists because that drag is a pointer gesture with no keyboard equivalent at all -- without
 * these two entries, arranging the canvas would be something you could only do with a mouse.
 */
export function BotCardMenu({
  bot,
  onDetach,
  onMoveLeft,
  onMoveRight,
}: {
  bot: BotView;
  onDetach: () => void;
  /** Absent at the left end of the strip, where there is nowhere further to go. */
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}) {
  return (
    <RowMenu
      label={bot.name}
      items={[
        ...(onMoveLeft ? [{ label: "Move left", icon: ArrowLeft, onSelect: onMoveLeft }] : []),
        ...(onMoveRight ? [{ label: "Move right", icon: ArrowRight, onSelect: onMoveRight }] : []),
        { label: "Remove from canvas", icon: Unlink, onSelect: onDetach },
      ]}
    />
  );
}
