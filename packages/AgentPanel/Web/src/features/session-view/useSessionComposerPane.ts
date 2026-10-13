// The session's own pane, as the composer shows it above its field: which pane, whether it is up,
// and the height it was left at.

import { useMemo, type ComponentProps } from "react";
import type { SessionComposer } from "@/features/session-view/composer/SessionComposer";
import {
  setTerminalComposerHeight,
  terminalComposerHeight,
  toggleTerminalComposer,
  useTerminalComposerShown,
} from "@/features/terminal/terminalComposerPreference";

/**
 * The composer's `terminalComposer`, or null for a source with no pane to show.
 *
 * The pane is named by the SESSION, and the sidecar resolves which tmux pane that is: the one a
 * live process is running in, or one it starts to resume the session id.
 *
 * It used to name the pane instead, read from `cliInput.tmuxSession`, and that could only ever
 * be half the sessions: the value comes from a live process's registry row, so a session running
 * outside tmux and a session not running at all both read as null and got no terminal. It also
 * had to be latched, because `cliInput` resets to idle on every status read and a terminal
 * mounted on the live value was torn down and re-attached every couple of seconds -- measured as
 * a close/open cycle in the network log. Naming the session removes both: the id is stable for
 * as long as the view is mounted, and nothing about it blinks.
 */
export function useSessionComposerPane(
  source: string,
  sessionId: string,
  shownByDefault: boolean,
): ComponentProps<typeof SessionComposer>["terminalComposer"] {
  const arrangement = useMemo(
    () => ({ source, sessionId, shownByDefault }),
    [source, sessionId, shownByDefault],
  );
  const shown = useTerminalComposerShown(arrangement);
  if (source !== "claude" && source !== "codex" && source !== "opencode") return null;
  return {
    context: { kind: "session-tmux", source, sessionId },
    shown,
    toggle: () => toggleTerminalComposer(arrangement),
    // Read on every render and used by the pane only on the one it mounts in. A store that kept
    // pushing would fight the drag it exists to remember.
    height: terminalComposerHeight(arrangement),
    onResized: (height) => setTerminalComposerHeight(arrangement, height),
  };
}
