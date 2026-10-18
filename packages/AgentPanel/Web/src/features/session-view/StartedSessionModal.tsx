// A session started from the Sessions view, in the modal it will keep, before it is a session.
//
// The same gap `BotNewSessionCard` fills on the canvas: a fresh Claude session writes no transcript
// until its first turn, so for that minute nothing the panel reads from knows it exists, and there
// is no `SessionSummary` for `SessionModal` to render. What there is from the first second is its
// pane, so that is the whole box: the terminal, which is also the only thing a session with no
// history could usefully show, and what makes the session real by being typed into.
//
// It hands itself over the moment the catalog lists the session, so the reader sees the transcript
// view replace the terminal in the same box rather than a box closing. An opencode session is
// listed as soon as the serve creates it, so for one of those this is a moment, not a minute.
//
// A Claude session run through the Agent SDK skips the terminal: its pane holds the runner's log,
// not a prompt box, and the runner answers on the session id from the first second. So it opens in
// the session view straight away, with the feed empty until the catalog lists the session and the
// composer sending through the runner, and is handed over the same way.

import { SquareTerminal, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectSummary, SessionSummary, StartedSourceSession } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { awaitedSession } from "@/features/session-view/awaitedSession";
import { SessionModal } from "@/features/session-view/SessionModal";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { useMountEffect } from "@/hooks/useMountEffect";
import { useNotify } from "@/hooks/useNotify";

/** A session this panel started, and whether it runs through the SDK runner rather than the terminal. */
export type StartedNewSession = StartedSourceSession & { sdk: boolean };

function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** The project it runs in. A directory with no sessions before this one may not be listed yet. */
function projectOf(started: StartedNewSession, projects: readonly ProjectSummary[], at: number): ProjectSummary {
  return (
    projects.find((entry) => entry.projectPath === started.projectPath) ?? {
      projectPath: started.projectPath,
      displayName: folderName(started.projectPath),
      sourceCounts: { [started.source]: 1 },
      sessionCount: 1,
      lastEventAt: at,
    }
  );
}

export function StartedSessionModal({
  feed,
  context,
  started,
  projects,
  sessionsByProject,
  onListed,
  onClose,
}: {
  feed: SidecarDataSource;
  /** What the session view needs, for an SDK session opened in it before it is listed. */
  context: SessionViewContext;
  started: StartedNewSession;
  projects: readonly ProjectSummary[];
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  /** The catalog has it: open it as an ordinary session, in place of this. */
  onListed: (project: ProjectSummary, session: SessionSummary) => void;
  /** Closes the box. The session keeps running in its pane, and is listed once it has spoken. */
  onClose: () => void;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);

  const listed =
    sessionsByProject
      .get(started.projectPath)
      ?.find((entry) => entry.source === started.source && entry.sessionId === started.sessionId) ?? null;
  // The catalog listing it is what hands the session over to the ordinary session modal.
  useNotify(listed, (session) => {
    if (session) onListed(projectOf(started, projects, session.lastEventAt), session);
  });

  // Focus moves in on open and back to whatever held it on close, the way a dialog's does.
  useMountEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => previous?.focus();
  });

  // When the modal opened, which is when the session it waits for was last heard of.
  const [openedAt] = useState(Date.now);
  // Not rebuilt on every render: the view keys its effects on the objects it is handed.
  const awaited = useMemo(
    () => ({
      project: projectOf(started, projects, openedAt),
      session: awaitedSession(started.source, started.sessionId, started.title, null),
    }),
    [projects, started, openedAt],
  );

  if (started.sdk) {
    return <SessionModal context={context} {...awaited} listed={false} onClose={onClose} />;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-2 sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-[min(100%,56rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl"
      >
        <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border py-1 pr-1 pl-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">
              {started.title}
            </h2>
            <p className="flex min-w-0 items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
              <SourceBadge source={started.source} />
              <span className="truncate">{folderName(started.projectPath)}, no transcript yet</span>
            </p>
          </div>
          {/* No Escape handler: the terminal below takes every key, Escape included, and a box
              that closed on it would take the key a Claude session uses to interrupt itself. */}
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close session"
            title="Close"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <section
          ref={setBody}
          className="flex min-h-0 flex-1 flex-col bg-background"
          aria-label={`${started.title} session`}
        >
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            <SquareTerminal className="size-5" aria-hidden />
            <p>Type below to give it its first turn; the transcript replaces this once it has one.</p>
          </div>
          <AgentTerminalPane
            feed={feed}
            // Attaching, not starting: the sidecar started the session before this box existed.
            context={{ kind: "tmux", session: started.tmuxSession }}
            layout="band"
            heightBasis={body}
          />
        </section>
      </div>
    </div>,
    document.body,
  );
}
