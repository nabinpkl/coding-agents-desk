// Moving a terminal session to one named permission mode.
//
// Claude's terminal has no key for "this mode", only Shift+Tab to the next one, and which modes the
// cycle visits depends on how the session was started (bypass is in it only for a session launched
// allowing it). So the sidecar presses and reads the footer back after every press, stopping at the
// mode asked for. Done here rather than in the panel because this side reads the pane directly,
// where the panel would wait on a stream round trip per press.

import {
  bytesForRailKey,
  NO_MODIFIERS,
  type ClaudePermissionMode,
  type TmuxPermissionModeOutcome,
} from "@agentdesk/agent-feed-wire";
import { TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";
import { permissionModeOn } from "@/input/permissionModeFooter";
import { paneFor } from "@/input/tmuxComposer";
import { inTurn } from "@/input/tmuxComposerPanes";
import { LIVE, type TmuxComposerRuntime } from "@/input/tmuxComposerRuntime";

const SHIFT_TAB = new TextEncoder().encode(bytesForRailKey("tab", { ...NO_MODIFIERS, shift: true }));

/** How long one press gets to show in the footer before the switch says the pane did not answer. */
const REDRAW_LIMIT_MS = 2_000;
const POLL_MS = 40;

type Wait = (ms: number) => Promise<void>;

const LABELS: Record<ClaudePermissionMode, string> = {
  acceptEdits: "accept edits",
  auto: "auto",
  bypassPermissions: "bypass",
  manual: "manual",
  dontAsk: "don't ask",
  plan: "plan",
};

/**
 * Presses Shift+Tab in the session's pane until its footer names `target`.
 *
 * Stops, rather than pressing on, the moment the cycle comes back to a mode it has already shown:
 * that mode is never reached by this session's Shift+Tab, and the presses so far have brought the
 * session round to where it started.
 */
export function setTmuxPermissionMode(
  sessionId: string,
  target: ClaudePermissionMode,
  runtime: TmuxComposerRuntime = LIVE,
  wait: Wait = (ms) => new Promise<void>((done) => setTimeout(done, ms)),
): Promise<TmuxPermissionModeOutcome> {
  // In turn with every other key sent to this box, so a press from the key rail cannot land in
  // the middle of the cycle and leave the footer somewhere neither asked for.
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return { ok: false, reason: "no-pane", message: "this session has no terminal to switch", mode: null };
      let current = await modeIn(pane, runtime);
      if (current === null) {
        return {
          ok: false,
          reason: "no-footer",
          message: "the terminal is not showing its mode right now, as when a dialog covers it",
          mode: null,
        };
      }
      const seen: ClaudePermissionMode[] = [current];
      while (current !== target) {
        await runtime.send(pane, SHIFT_TAB);
        const next = await modeAfterPress(pane, current, runtime, wait);
        if (next === null) {
          return {
            ok: false,
            reason: "no-response",
            message: `Shift+Tab did not move the mode from ${LABELS[current]}`,
            mode: current,
          };
        }
        if (seen.includes(next)) {
          return {
            ok: false,
            reason: "unreachable",
            message: `this session's Shift+Tab goes ${seen.map((mode) => LABELS[mode]).join(", ")} and never reaches ${LABELS[target]}`,
            mode: next,
          };
        }
        seen.push(next);
        current = next;
      }
      return { ok: true, mode: current };
    } catch (error) {
      if (!(error instanceof TmuxUnavailable)) throw error;
      runtime.panes.forget(sessionId);
      return { ok: false, reason: "tmux-unavailable", message: "tmux did not answer", mode: null };
    }
  });
}

async function modeIn(pane: string, runtime: TmuxComposerRuntime): Promise<ClaudePermissionMode | null> {
  return permissionModeOn((await runtime.screen(pane)).screen);
}

/**
 * The footer's mode once it differs from `before`, or null if it does not within the limit.
 *
 * A footer that reads as nothing is a redraw in flight, not an answer, so it keeps looking.
 */
async function modeAfterPress(
  pane: string,
  before: ClaudePermissionMode,
  runtime: TmuxComposerRuntime,
  wait: Wait,
): Promise<ClaudePermissionMode | null> {
  for (let waited = 0; waited <= REDRAW_LIMIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const mode = await modeIn(pane, runtime);
    if (mode !== null && mode !== before) return mode;
  }
  return null;
}
