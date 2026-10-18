"use client";

// Archiving a session, and the list that gives archived ones back.
//
// Archived is ours: the sidecar keeps it in `session-archive.json` and every surface hides the
// session until it is unarchived. The inventory splits archived rows off before anything lists
// them (`subscribeInventory`), and Bot views never carry one, so the only place an archived
// session is drawn at all is the per-project toggle below.

import { ArchiveRestore, ChevronDown, LoaderCircle } from "lucide-react";
import { useCallback, useState } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionMeta } from "@/features/sidebar/session-list/SessionMeta";
import type { ProjectArchiving } from "@/features/sidebar/session-list/ArchivedProjects";

export type SetSessionArchived = (session: SessionSummary, archived: boolean) => Promise<void>;

/** What a list needs to offer Archive and Unarchive. Absent where neither is offered. */
export interface SessionArchiving {
  archivedByProject: ReadonlyMap<string, SessionSummary[]>;
  setArchived: SetSessionArchived;
  /** Archiving a whole project folder. Absent where only single sessions are offered. */
  projects?: ProjectArchiving;
}

function keyOf(session: SessionSummary): string {
  return `${session.source}:${session.sessionId}`;
}

/**
 * One archive command at a time per surface, and the reason it failed.
 *
 * Nothing is set on success: the inventory and Bot streams republish without the session, so the
 * row leaves on its own. A failure stays until the next attempt, against the session it was about,
 * because the commonest one -- "still running" -- is an instruction the reader has to act on.
 */
export function useSessionArchiveCommand(setArchived: SetSessionArchived | undefined) {
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const run = useCallback(
    (session: SessionSummary, archived: boolean) => {
      if (!setArchived) return;
      const key = keyOf(session);
      setFailure(null);
      setPending(key);
      void setArchived(session, archived)
        .catch((error: unknown) => {
          setFailure({
            key,
            message: `Could not ${archived ? "archive" : "unarchive"} ${session.title || session.sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        })
        .finally(() => setPending((current) => (current === key ? null : current)));
    },
    [setArchived],
  );
  const failureFor = (session: SessionSummary): string | null =>
    failure?.key === keyOf(session) ? failure.message : null;
  const isPending = (session: SessionSummary): boolean => pending === keyOf(session);
  return { run, failureFor, isPending };
}

export function ArchiveFailure({ message, className = "" }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={`text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive ${className}`}>
      {message}
    </p>
  );
}

/**
 * A project's archived sessions, folded behind a count.
 *
 * Folded by default and not remembered: it is a way back, not a view anyone reads, and a reload
 * that left it open would be showing the reader what they had filed away.
 */
export function ArchivedSessions({
  archived,
  setArchived,
}: {
  archived: SessionSummary[] | undefined;
  setArchived: SetSessionArchived;
}) {
  const [open, setOpen] = useState(false);
  const command = useSessionArchiveCommand(setArchived);
  if (!archived || archived.length === 0) return null;
  return (
    <div className="pb-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-9 w-full cursor-pointer items-center gap-1.5 px-8 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground"
      >
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        Archived ({archived.length})
      </button>
      {open ? (
        <ul role="list" aria-label="Archived sessions">
          {archived.map((session) => {
            const pending = command.isPending(session);
            const title = session.title || session.sessionId;
            return (
              <li key={keyOf(session)} className="flex flex-col">
                <div className="flex items-center">
                  <span className="min-w-0 flex-1 py-2 pr-2 pl-8">
                    <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                      {title}
                    </span>
                    <SessionMeta
                      source={session.source}
                      lastEventAt={session.lastEventAt}
                      activity={session.activity}
                    />
                  </span>
                  <button
                    type="button"
                    onClick={() => command.run(session, false)}
                    disabled={pending}
                    aria-label={`Unarchive ${title}`}
                    title="Unarchive"
                    className="mr-1 flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-60"
                  >
                    {pending ? (
                      <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <ArchiveRestore className="size-3.5" aria-hidden />
                    )}
                    Unarchive
                  </button>
                </div>
                <ArchiveFailure message={command.failureFor(session)} className="px-8 pb-2" />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
