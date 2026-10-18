// The permission modes a reader can put a Claude session in, as the mode chip's menu offers them.
//
// One list for both kinds of session: an SDK session sets the mode through its runner, a terminal
// one by Shift+Tab until its footer names it. `dontAsk` is a mode the CLI accepts and its cycle was
// never seen to visit, so it is named (a session started in it still says so) but not offered.

import { BellOff, ClipboardList, createLucideIcon, FilePen, Hand, ShieldAlert, type LucideIcon } from "lucide-react";
import type { ClaudePermissionMode } from "@agentdesk/agent-feed-wire";

/**
 * A capital A in Lucide's own stroke, for Auto. Lucide has no plain letter, and the lightning bolt
 * Auto had read as fast mode.
 */
const LetterA = createLucideIcon("letter-a", [
  ["path", { d: "m6 20 6-16 6 16", key: "letter-a-legs" }],
  ["path", { d: "M8.25 14h7.5", key: "letter-a-bar" }],
]);

/** What the chip says for each mode: the words Claude's own footer uses, shortened. */
export const PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  auto: "Auto",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass",
  manual: "Manual",
  dontAsk: "Don't ask",
};

/** Each mode's glyph: the chip shows only this on a narrow footer, and the menu teaches it. */
export const PERMISSION_MODE_ICONS: Record<ClaudePermissionMode, LucideIcon> = {
  plan: ClipboardList,
  manual: Hand,
  acceptEdits: FilePen,
  auto: LetterA,
  bypassPermissions: ShieldAlert,
  dontAsk: BellOff,
};

/** One line each, for a menu row on a narrow card. */
const DESCRIPTIONS: Record<Exclude<ClaudePermissionMode, "dontAsk">, string> = {
  plan: "Reads and plans. Changes nothing.",
  manual: "Asks before every edit and command.",
  acceptEdits: "Edits files without asking. Asks before commands.",
  auto: "Runs routine actions itself. Asks about the rest.",
  bypassPermissions: "Runs everything without asking.",
};

/** Ordered by how much the session may do without asking, least first. */
const OFFERED = ["plan", "manual", "acceptEdits", "auto", "bypassPermissions"] as const;

export interface PermissionModeChoice {
  value: ClaudePermissionMode;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Set when the mode cannot be chosen, saying why, in place of the description. */
  unavailable?: string;
  warning?: boolean;
}

/**
 * The menu's rows. `bypassAllowed` is false only where it is KNOWN to be refused -- an SDK session
 * started without it. A terminal session cannot say ahead of time, so its row stays open and the
 * switch reports a cycle that never reaches it.
 */
export function permissionModeChoices(bypassAllowed: boolean): PermissionModeChoice[] {
  return OFFERED.map((value) => ({
    value,
    label: PERMISSION_MODE_LABELS[value],
    description: DESCRIPTIONS[value],
    icon: PERMISSION_MODE_ICONS[value],
    ...(value === "bypassPermissions"
      ? { warning: true, ...(bypassAllowed ? {} : { unavailable: "This session was started without bypass." }) }
      : {}),
  }));
}
