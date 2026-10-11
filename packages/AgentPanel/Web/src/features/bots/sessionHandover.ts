import type { SessionSummary } from "@agentdesk/agent-feed-wire";

/** The two harnesses a handover runs between, and what each is called on screen. */
export const HANDOVER_LABELS = { claude: "Claude", opencode: "opencode" } as const;

export type HandoverDestination = keyof typeof HANDOVER_LABELS;

/**
 * Where this session's context would go, or null when it can go nowhere.
 *
 * `canRenameSession`'s sibling, and here for the same reason: the question is asked where the
 * menu is built rather than inside it, and asked once so that every surface building that menu
 * agrees. Three callers would otherwise each carry their own condition -- the menu deciding
 * whether to offer the item, the command deciding which call to make, and the dialog deciding
 * what to say -- and those three disagreeing is a menu entry that opens a dialog that starts
 * nothing.
 *
 * A handover runs between Claude and opencode, so the destination is simply the other one. It
 * does not need a compaction: a session that never compacted hands over its whole conversation,
 * tool output cut to head and tail the way it is after a compaction. Codex is not a source
 * because the sidecar has no reader that renders its rows into a handover, not for want of one.
 */
export function handoverDestination(session: SessionSummary): HandoverDestination | null {
  if (session.source === "claude") return "opencode";
  if (session.source === "opencode") return "claude";
  return null;
}

/**
 * The session menu's handover item, or nothing where there is no handover.
 *
 * The destination and the action travel together, because a menu that says one and does the
 * other is the bug this shape makes unspellable.
 */
export function handoverMenuProp(
  session: SessionSummary,
  onSelect: () => void,
): { to: HandoverDestination; onSelect: () => void } | undefined {
  const to = handoverDestination(session);
  return to ? { to, onSelect } : undefined;
}
