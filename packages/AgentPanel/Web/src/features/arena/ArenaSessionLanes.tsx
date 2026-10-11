// The contestants' sessions, one per lane: the arena's reason to exist as a surface.
//
// Each lane is the same `SessionView` a canvas card renders -- transcript, controls, composer --
// given a column instead of a card, so a reader watches every contestant work the one prompt at
// once and scrolls each at its own pace. Nothing here re-renders a transcript: the lanes find each
// contestant's session in this machine's catalog and hand it to the component that already knows
// how to show one.
//
// The catalog is asked for the worktree directories the run made (and its repository, since a
// harness may file a worktree's session under its checkout), and lanes match by session id, the
// one identity both the arena and the catalog hold. A contestant whose session the catalog has
// not listed yet says so in its lane rather than leaving it empty.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArenaContestantDetail, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { SOURCE_LABEL, TEXT } from "@/features/arena/arenaVocabulary";

/** A catalog session and the directory it is listed under, which its terminal is named by. */
export interface ListedSession {
  session: SessionSummary;
  projectPath: string;
}

/** Every session the catalog holds in the run's directories, by id. */
export function useRunSessions(feed: SidecarDataSource, directories: readonly string[]): {
  sessions: ReadonlyMap<string, ListedSession>;
  error: string | null;
} {
  const key = useMemo(() => [...new Set(directories)].sort().join("\0"), [directories]);
  const [byDirectory, setByDirectory] = useState<ReadonlyMap<string, SessionSummary[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setByDirectory(new Map());
    setError(null);
    const stop = feed.subscribeInventory(
      key === "" ? [] : key.split("\0"),
      {
        onProjects: () => {},
        onSessions: (projectPath, sessions) => {
          if (live) setByDirectory((previous) => new Map(previous).set(projectPath, sessions));
        },
      },
      (reason) => {
        if (live) setError(reason);
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [feed, key]);
  const sessions = useMemo(() => {
    const out = new Map<string, ListedSession>();
    for (const [projectPath, list] of byDirectory) {
      for (const session of list) out.set(session.sessionId, { session, projectPath });
    }
    return out;
  }, [byDirectory]);
  return { sessions, error };
}

/**
 * One contestant's session, filling its lane under its facts. The lane's name and status sit in
 * the facts above it, so this row carries only the session's own controls.
 */
export function SessionLane({
  contestant,
  listed,
  context,
}: {
  contestant: ArenaContestantDetail;
  listed: ListedSession | null;
  context: SessionViewContext;
}) {
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  const [tasksHost, setTasksHost] = useState<HTMLElement | null>(null);
  const [acceptFiles, setAcceptFiles] = useState<((files: readonly File[]) => void) | null>(null);
  // Stable by construction, as `SessionView` requires: a fresh function here would republish on
  // every keystroke in the lane's composer.
  const takeAcceptFiles = useCallback(
    (accept: ((files: readonly File[]) => void) | null) => setAcceptFiles(() => accept),
    [],
  );
  const drop = useFileDropTarget<HTMLElement>(acceptFiles);
  const label = `${contestant.contestantId} ${SOURCE_LABEL[contestant.source]}`;

  return (
    <section
      aria-label={`${label} session`}
      className="relative flex min-h-0 min-w-0 flex-col bg-background"
      {...drop.dropProps}
    >
      {/* The session's own controls (mode, terminal, cache hits) portal into this row. */}
      <div
        ref={setControlsHost}
        className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-y border-border bg-muted/40 px-2"
      />
      {listed ? (
        <div className="min-h-0 flex-1">
          <SessionView
            key={listed.session.sessionId}
            {...context}
            projectPath={listed.projectPath}
            session={listed.session}
            controlsHost={controlsHost}
            tasksHost={tasksHost}
            onAcceptFiles={takeAcceptFiles}
          />
        </div>
      ) : (
        <div className={`flex flex-1 flex-col gap-2 px-4 py-6 ${TEXT.body}`}>
          <p className="text-muted-foreground">
            {contestant.sessionId === null
              ? contestant.status === "failed"
                ? "No session was made."
                : "Making this contestant's session."
              : "This session is not in the catalog yet; it appears here once it is listed."}
          </p>
          {contestant.sessionId ? (
            <p className={`font-mono ${TEXT.meta} text-muted-foreground`}>{contestant.sessionId}</p>
          ) : null}
        </div>
      )}
      <div ref={setTasksHost} className="contents" />
      <FileDropOverlay
        dragging={drop.dragging}
        refusal={acceptFiles !== null ? null : "This contestant has no composer to drop into"}
      />
    </section>
  );
}
