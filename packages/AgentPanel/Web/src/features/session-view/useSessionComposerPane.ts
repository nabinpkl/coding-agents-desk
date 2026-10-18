// The session's own pane, as the composer shows it above its field: which pane, whether it is up,
// and the height it was left at.

import { useMemo, type ComponentProps } from "react";
import type { SessionComposer } from "@/features/session-view/composer/SessionComposer";
import type { ComposerPaneContext } from "@/features/session-view/composer/terminalArrangement";
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
 * live process is running in, or one it starts to resume the session id. A surface that started
 * the pane itself names it instead (`pane`), and that pane is up until the reader hides it: the
 * reader is there to type in it, and the session may not be in the catalog yet for the sidecar to
 * resolve.
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
  pane: string | null,
): ComponentProps<typeof SessionComposer>["terminalComposer"] {
  const arrangement = useMemo(() => ({ source, sessionId, shownByDefault: pane !== null }), [source, sessionId, pane]);
  const context = useMemo<ComposerPaneContext | null>(() => {
    if (pane !== null) return { kind: "tmux", session: pane };
    if (source !== "claude" && source !== "codex" && source !== "opencode") return null;
    return { kind: "session-tmux", source, sessionId };
  }, [pane, source, sessionId]);
  const shown = useTerminalComposerShown(arrangement);
  if (context === null) return null;
  return {
    context,
    shown,
    toggle: () => toggleTerminalComposer(arrangement),
    // Read on every render and used by the pane only on the one it mounts in. A store that kept
    // pushing would fight the drag it exists to remember.
    height: terminalComposerHeight(arrangement),
    onResized: (height) => setTerminalComposerHeight(arrangement, height),
  };
}
