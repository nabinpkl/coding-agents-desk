// Whether a Bot's session card has its code viewer open, and on which file.
//
// The card holds this rather than its button, because the viewer outlives the controls row: the
// row goes when the card folds, and a viewer open over the canvas should not go with it.

import { useContext, useMemo, useState } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import {
  FilePathOpenerContext,
  type FilePathOpener,
  type FilePathTarget,
} from "@/features/activity-feed/markdown/filePathLinks";

export interface SessionCode {
  /** Open, on a file the transcript named or on the folder (`file: null`); null while shut. */
  request: { file: FilePathTarget | null } | null;
  openFolder: () => void;
  close: () => void;
  /**
   * What opens the paths its transcript names. For a session in a worktree, read against that
   * worktree and opened in this card's viewer; for one in the Bot's directory, the Bot card's own.
   */
  opener: FilePathOpener | null;
}

export function useSessionCode(session: SessionSummary): SessionCode {
  const [request, setRequest] = useState<{ file: FilePathTarget | null } | null>(null);
  const botOpener = useContext(FilePathOpenerContext);
  const root = session.worktree?.path ?? null;
  const opener = useMemo<FilePathOpener | null>(
    () => (root === null ? botOpener : { root, open: (file) => setRequest({ file }) }),
    [botOpener, root, setRequest],
  );
  return { request, openFolder: () => setRequest({ file: null }), close: () => setRequest(null), opener };
}
