// Whether a Bot's session has its code viewer open, and on which file: on its card, or in the
// session modal it was maximized into.
//
// The card holds this rather than its button, because the viewer outlives the controls row: the
// row goes when the card folds, and a viewer open over the canvas should not go with it.

import { useContext, useMemo, useState } from "react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import {
  FilePathOpenerContext,
  type FilePathOpener,
  type FilePathTarget,
} from "@/features/activity-feed/markdown/filePathLinks";

export interface SessionCode {
  /** Open, on a file the transcript named or on the folder (`file: null`); null while shut. */
  request: { file: FilePathTarget | null } | null;
  openFolder: () => void;
  /** Opens this session's own viewer on one file, as its log button does. */
  openFile: (file: FilePathTarget) => void;
  close: () => void;
  /**
   * What opens the paths its transcript names. For a session in a worktree, read against that
   * worktree and opened in this viewer. For one in the Bot's directory, whatever opener is around it
   * already (a Bot card's own), and where there is none, as in the modal, this viewer on the Bot's
   * directory. Null with no Bot, or one whose directory is missing.
   */
  opener: FilePathOpener | null;
}

export function useSessionCode(session: SessionSummary, bot: BotView | undefined): SessionCode {
  const [request, setRequest] = useState<{ file: FilePathTarget | null } | null>(null);
  const around = useContext(FilePathOpenerContext);
  const directory = bot && bot.environmentAvailability !== "missing" ? bot.environment.path : null;
  const root = session.worktree?.path ?? null;
  const opener = useMemo<FilePathOpener | null>(() => {
    const open = (file: FilePathTarget) => setRequest({ file });
    if (root !== null) return { root, open };
    if (around !== null) return around;
    return directory === null ? null : { root: directory, open };
  }, [around, directory, root, setRequest]);
  return {
    request,
    openFolder: () => setRequest({ file: null }),
    openFile: (file) => setRequest({ file }),
    close: () => setRequest(null),
    opener,
  };
}
