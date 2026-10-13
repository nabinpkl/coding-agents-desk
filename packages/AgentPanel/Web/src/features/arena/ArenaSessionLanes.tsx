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
//
// A contestant driven in a terminal also has its pane in the lane, joined with the same terminal
// a canvas card uses: typeable, so a reader can answer what the harness asks on its way up (a
// folder-trust question) or step into the session afterwards. Before a Claude contestant's first
// turn the catalog has nothing to list, so its lane shows the empty feed every lane starts with,
// over its terminal, until the transcript lands.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArenaContestantDetail, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
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
  // What the terminal band's height is a share of: the lane, not the viewport (see `heightBasis`).
  const [lane, setLane] = useState<HTMLElement | null>(null);
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
      ref={setLane}
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
      ) : contestant.tmuxSession ? (
        // The feed this session will have, empty, as a listed session's own feed reads before its
        // first turn: the terminal under it is where the session is coming up.
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-(length:--agent-panel-fs-canvas-menu,13px) text-muted-foreground">
          <p>no events</p>
          <p>{unlistedLine(contestant)}</p>
        </div>
      ) : (
        <div className={`flex flex-1 flex-col gap-2 px-4 py-6 ${TEXT.body}`}>
          <p className="text-muted-foreground">{unlistedLine(contestant)}</p>
          {contestant.sessionId ? (
            <p className={`font-mono ${TEXT.meta} text-muted-foreground`}>{contestant.sessionId}</p>
          ) : null}
        </div>
      )}
      {contestant.tmuxSession ? (
        <AgentTerminalPane
          // Keyed by the pane, so a lane that moves to another contestant joins that one afresh.
          key={contestant.tmuxSession}
          feed={context.feed}
          // Joining, not starting: the arena started the pane, and opening it twice is once.
          context={{ kind: "tmux", session: contestant.tmuxSession }}
          layout="band"
          heightBasis={lane}
        />
      ) : null}
      <div ref={setTasksHost} className="contents" />
      <FileDropOverlay
        dragging={drop.dragging}
        refusal={acceptFiles !== null ? null : "This contestant has no composer to drop into"}
      />
    </section>
  );
}

/** What a lane says while its contestant has no listed session to show. */
function unlistedLine(contestant: ArenaContestantDetail): string {
  if (contestant.sessionId === null) {
    return contestant.status === "failed" ? "No session was made." : "Making this contestant's session.";
  }
  if (contestant.status === "starting") return "Starting in its terminal";
  if (contestant.status === "ready") return "Ready for the prompt";
  return "This session is not in the catalog yet; it appears here once it is listed.";
}
