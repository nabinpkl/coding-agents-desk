import { EyeOff, GitFork, Pencil, Unlink } from "lucide-react";
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
