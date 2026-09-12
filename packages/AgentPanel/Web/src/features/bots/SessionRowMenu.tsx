import { GitFork, Pencil, Unlink } from "lucide-react";
import { RowMenu, type RowMenuItem } from "./RowMenu";

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
}) {
  const items: RowMenuItem[] = [];
  if (onRename) items.push({ label: "Rename session", icon: Pencil, onSelect: onRename });
  if (onFork) items.push({ label: "Fork session", icon: GitFork, onSelect: onFork });
  // "from bot", not "from canvas": this drops the Bot's reference to the session wherever the row
  // is being read, and the sibling menu on the card header is the one that means the canvas.
  items.push({ label: "Remove from bot", icon: Unlink, onSelect: onDetach });
  return <RowMenu label={label} items={items} />;
}
