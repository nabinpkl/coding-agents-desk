import { EyeOff, GitBranch, GitFork, Pencil, Scissors, Unlink } from "lucide-react";
import { RowMenu, type RowMenuItem } from "@/features/bots/menus/RowMenu";

/**
 * The per-session actions menu, on a row that names one session a Bot has been given.
 *
 * Shared by the Bots sidebar and the Bot canvas, which show the same rows in two densities and
 * offer the same actions on them.
 */
export function SessionRowMenu({
  label,
  onRename,
  onFork,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onDetach,
  onRemoveFromCanvas,
}: {
  label: string;
  /**
   * Gives the session a new title. Absent for the same reason `onFork` is: a missing reference has
   * no transcript, and the title being renamed is a record inside one.
   */
  onRename?: () => void;
  /**
   * Starts a new session branched from this one. Absent on a row with no transcript to branch
   * from, which is what a missing reference is.
   */
  onFork?: () => void;
  /**
   * Starts a new session branched just before the last thing a person said in this one.
   *
   * The same fork the ⋮ on a message offers, asked for from the session instead. That menu is on
   * the row, so on a long transcript -- one turn of tool calls is enough -- the affordance sits
   * hundreds of rows above the bottom, and taking it means scrolling back to find the message. The
   * last one is the one a reader almost always wants, and this is the two-click way to it.
   *
   * Absent for the same reason `onFork` is, plus one: which message is the last is a question
   * about a transcript, so a row with none has no answer.
   */
  onForkFromLastMessage?: () => void;
  /**
   * Starts a new session branched at this one's newest compaction.
   *
   * The narrowest of the three, and the one a reader reaches for after a turn went wrong on a
   * summarised context: it drops everything said since the summary rather than everything said
   * since their last message. Absent for `onFork`'s reason, plus its own -- a session that has
   * never been compacted has no such point, and one that has not been spoken to since a compaction
   * is already at it, which is what the plain fork above does.
   */
  onForkFromLastCompaction?: () => void;
  onDetach: () => void;
  /**
   * Takes this session's card off the canvas and changes nothing about the Bot.
   *
   * Absent everywhere there is no canvas to be taken off, which is the Bots tab and the sidebar
   * roster -- the same split the Bot's own header menu has, where "Remove from canvas" lives on
   * the card and the sidebar's way back is clicking the row.
   */
  onRemoveFromCanvas?: () => void;
}) {
  const items: RowMenuItem[] = [];
  if (onRename) items.push({ label: "Rename session", icon: Pencil, onSelect: onRename });
  if (onFork) items.push({ label: "Fork session", icon: GitFork, onSelect: onFork });
  // Under the whole-session fork, because it is the narrower of the two and reads as a variant of
  // it: one takes the conversation entire, this one stops just before the last thing you said.
  if (onForkFromLastMessage) {
    items.push({ label: "Fork from last message", icon: GitBranch, onSelect: onForkFromLastMessage });
  }
  // Under that one, and narrower again: a compaction is further back than the last thing you said,
  // so the three read as one list widening from "the whole conversation" down to "since the
  // context was summarised".
  if (onForkFromLastCompaction) {
    items.push({
      label: "Fork from last compaction",
      icon: Scissors,
      onSelect: onForkFromLastCompaction,
    });
  }
  // "from bot", not "from canvas": this drops the Bot's reference to the session wherever the row
  // is being read, and is the only one of the two that asks the sidecar for anything. Both survive
  // a reload; only this one survives it for somebody else.
  items.push({ label: "Remove from bot", icon: Unlink, onSelect: onDetach });
  // Below the Bot-level removal, and worded as the smaller act it is: this one is undone by
  // clicking the session in the sidebar, where every session a Bot holds is listed whether or not
  // its card is on the canvas.
  if (onRemoveFromCanvas) {
    items.push({ label: "Remove from canvas", icon: EyeOff, onSelect: onRemoveFromCanvas });
  }
  return <RowMenu label={label} items={items} />;
}
