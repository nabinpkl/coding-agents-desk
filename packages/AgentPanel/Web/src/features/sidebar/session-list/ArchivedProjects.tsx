"use client";

// Archiving a whole project folder, archiving every session in one, and the fold that gives
// archived folders back.
//
// An archived folder leaves the project list along with every session in it; the sidecar marks the
// project and each of its sessions, and the inventory splits archived projects off before anything
// lists them (`subscribeInventory`). So the only place an archived folder is drawn is the fold at
// the bottom of the project list, below.

import { ArchiveRestore, ChevronDown, LoaderCircle } from "lucide-react";
import { useCallback, useState } from "react";
import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import { ArchiveFailure } from "@/features/sidebar/session-list/ArchivedSessions";

/** What a project list needs to offer archiving a folder. Absent where it is not offered. */
export interface ProjectArchiving {
  archived: readonly ProjectSummary[];
  setArchived: (projectPath: string, archived: boolean) => Promise<void>;
  archiveSessions: (projectPath: string) => Promise<{ archived: number; running: number }>;
}

export type ProjectArchiveAction = "archive" | "unarchive" | "archive-sessions";

export function projectDisplayName(project: ProjectSummary): string {
  return project.displayName || project.projectPath.split("/").pop() || project.projectPath;
}

/**
 * One folder command at a time per list, and what it left to say.
 *
 * Nothing is set when a folder is archived or unarchived: the inventory republishes and the folder
 * moves on its own. A refusal stays against its folder until the next attempt, because the
 * commonest one -- "still running" -- is an instruction the reader has to act on. Archive all
 * sessions also leaves a note when it skipped running sessions, since the folder then still shows
 * rows and the reader should know why.
 */
export function useProjectArchiveCommand(archiving: ProjectArchiving | undefined) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ projectPath: string; message: string } | null>(null);
  const run = useCallback(
    (project: ProjectSummary, action: ProjectArchiveAction) => {
      if (!archiving) return;
      const { projectPath } = project;
      const name = projectDisplayName(project);
      setNotice(null);
      setPending(projectPath);
      const work =
        action === "archive-sessions"
          ? archiving.archiveSessions(projectPath).then(({ running }) => {
              if (running === 0) return;
              setNotice({
                projectPath,
                message: `${running} running ${running === 1 ? "session was" : "sessions were"} left in ${name}; stop ${
                  running === 1 ? "it" : "them"
                } to archive ${running === 1 ? "it" : "them"} too.`,
              });
            })
          : archiving.setArchived(projectPath, action === "archive");
      void work
        .catch((error: unknown) => {
          const verb = action === "archive-sessions" ? "archive the sessions in" : action;
          setNotice({
            projectPath,
            message: `Could not ${verb} ${name}: ${error instanceof Error ? error.message : String(error)}`,
          });
        })
        .finally(() => setPending((current) => (current === projectPath ? null : current)));
    },
    [archiving],
  );
  const noticeFor = (projectPath: string): string | null =>
    notice?.projectPath === projectPath ? notice.message : null;
  const isPending = (projectPath: string): boolean => pending === projectPath;
  return { run, noticeFor, isPending };
}

export type ProjectArchiveCommand = ReturnType<typeof useProjectArchiveCommand>;

/**
 * Archived project folders, folded behind a count at the bottom of the project list.
 *
 * Folded by default and not remembered, for the same reason as a project's archived sessions: it
 * is a way back, not a view anyone reads.
 */
export function ArchivedProjects({
  archiving,
  command,
}: {
  archiving: ProjectArchiving;
  command: ProjectArchiveCommand;
}) {
  const [open, setOpen] = useState(false);
  if (archiving.archived.length === 0) return null;
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground"
      >
        <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        Archived projects ({archiving.archived.length})
      </button>
      {open ? (
        <ul role="list" aria-label="Archived projects">
          {archiving.archived.map((project) => {
            const name = projectDisplayName(project);
            const pending = command.isPending(project.projectPath);
            return (
              <li key={project.projectPath} className="flex flex-col">
                <div className="flex items-center">
                  <span className="min-w-0 flex-1 py-2 pr-2 pl-9">
                    <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                      {name}
                    </span>
                    <span className="block text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground/80">
                      {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => command.run(project, "unarchive")}
                    disabled={pending}
                    aria-label={`Unarchive ${name}`}
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
                <ArchiveFailure message={command.noticeFor(project.projectPath)} className="px-9 pb-2" />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
