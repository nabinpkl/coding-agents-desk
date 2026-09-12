// Starting a fresh Pi session in a project, and what the sidebar says while it happens.
//
// A whole file for one command because it is the one command with a per-project pending state:
// the sidebar shows a spinner on the row it was pressed on and an error under that same row, and
// both belong to the project rather than to the panel.

import { useCallback, useState } from "react";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

export function usePiSessionCreation(
  feed: SidecarDataSource,
  openSession: (project: ProjectSummary, session: SessionSummary) => void,
  /** Cleared first, because a new Pi session is a catalog selection rather than a Bot one. */
  setSelectedBotId: (botId: string | null) => void,
) {
  const [creatingProjectPath, setCreatingProjectPath] = useState<string | null>(null);
  const [creationErrors, setCreationErrors] = useState<Map<string, string>>(new Map());

  const createPiSession = useCallback(async (project: ProjectSummary) => {
    if (creatingProjectPath) return;
    setCreatingProjectPath(project.projectPath);
    setCreationErrors((current) => {
      const next = new Map(current);
      next.delete(project.projectPath);
      return next;
    });
    try {
      const created = await feed.createSession(project.projectPath, "pi");
      // Everything but the source comes from the descriptor, because the sidecar decides the
      // title, timestamps, and capabilities. The source is the one we asked for: the descriptor
      // widens it to a bare string so a backend can register an identifier neither side's build
      // knows, and this call site is not that case.
      setSelectedBotId(null);
      openSession(project, {
        sessionId: created.sessionId,
        source: "pi",
        title: created.title,
        lastEventAt: created.lastEventAt,
        activity: created.activity,
        capabilities: created.capabilities,
      });
    } catch (error) {
      const message = String((error as Error).message ?? error);
      setCreationErrors((current) => new Map(current).set(project.projectPath, message));
    } finally {
      setCreatingProjectPath(null);
    }
  }, [feed, creatingProjectPath, openSession]);

  return { creatingProjectPath, creationErrors, createPiSession };
}
