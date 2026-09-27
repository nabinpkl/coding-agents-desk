/**
 * Where a dropped, picked or pasted file goes, decided in one place.
 *
 * Claude images ride the pane's own drop: its composer turns a pasted path into an image, and
 * the sidecar that answers is the process on the pane's machine, so it is the only party that
 * can write a file that pane's Claude can read. A drop is therefore a transfer, not a
 * reference -- and refused where the panel KNOWS there is nowhere to put it, which is a
 * session whose pane has been looked for and not found. Everywhere else there is somewhere,
 * because an opencode session holds its picks itself and sends them with its turn.
 */

import { useCallback, useEffect } from "react";

export function useComposerFileDrop(options: {
  isClaude: boolean;
  noPane: boolean;
  isOpencode: boolean;
  dropToPane: (files: readonly File[]) => void;
  holdForSend: (files: readonly File[]) => void;
  engage: () => void;
  onFileDrop: (drop: { accept: (files: readonly File[]) => void } | null) => void;
}): ((files: readonly File[]) => void) | null {
  const { isClaude, noPane, isOpencode, dropToPane, holdForSend, engage, onFileDrop } = options;

  // Registered for every Claude session rather than only for an attached band, because a
  // dropped image is intent as much as a keystroke is and there is nothing to drop onto if the
  // target waits for the pane. The drop itself is a POST that resolves the pane for itself;
  // engaging beside it is what brings the box into the field, so the `[Image #1]` the pane
  // writes appears where the reader is typing rather than in a mirror nobody opened.
  const acceptToPane = useCallback((files: readonly File[]) => {
    engage();
    void dropToPane(files);
  }, [dropToPane, engage]);

  const fileAccept = isClaude && !noPane
    ? acceptToPane
    : isOpencode
      ? holdForSend
      : null;
  useEffect(() => {
    // Null unregisters, which is how sessions with nowhere to put an image stand down.
    onFileDrop(fileAccept ? { accept: fileAccept } : null);
    return () => onFileDrop(null);
  }, [fileAccept, onFileDrop]);
  return fileAccept;
}
