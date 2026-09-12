"use client";

import { ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { ActivityDot, SessionMeta } from "@/features/sidebar/SessionMeta";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { InlineStatus } from "@/features/sidebar/SidebarStatusRows";


const INITIAL_SESSION_COUNT = 3;
const SESSION_BATCH_SIZE = 10;

export function ProjectSidebarItem({
  project,
  sessions,
  expanded,
  active,
  selectedSessionKey,
  creating,
  creationError,
  onToggle,
  onSelectSession,
  onCreatePiSession,
}: {
  project: ProjectSummary;
  sessions: SessionSummary[] | undefined;
  expanded: boolean;
  active: boolean;
  selectedSessionKey: string | null;
  creating: boolean;
  creationError: string | null;
  onToggle: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onCreatePiSession: () => void;
}) {
  const regionId = useId();
  const displayName = project.displayName || project.projectPath.split("/").pop() || project.projectPath;
  return (
    <li className="border-b border-border/80">
      <div className={active ? "bg-muted/45" : undefined}>
        <div className="flex min-h-11 items-stretch">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={regionId}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/60"
          >
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-medium">
                {displayName}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                <span>{project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}</span>
                {Object.entries(project.sourceCounts)
                  .filter(([, count]) => count > 0)
                  .map(([source]) => <SourceBadge key={source} source={source} />)}
              </span>
            </span>
          </button>
          {expanded ? (
            <button
              type="button"
              onClick={onCreatePiSession}
              disabled={creating}
              aria-label={`New Pi session in ${displayName}`}
              title="New Pi session"
              className="flex min-w-11 shrink-0 items-center justify-center gap-1 px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {creating ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              <span>Pi</span>
            </button>
          ) : null}
        </div>
        {creationError ? (
          <p role="alert" className="px-9 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
            Pi session unavailable: {creationError}
          </p>
        ) : null}
      </div>
      {expanded ? (
        <div id={regionId} role="region" aria-label={`${displayName} sessions`}>
          <ProjectSessionPreview
            sessions={sessions}
            selectedSessionKey={selectedSessionKey}
            onSelect={onSelectSession}
          />
        </div>
      ) : null}
    </li>
  );
}

export function ProjectSessionPreview({
  sessions,
  selectedSessionKey,
  onSelect,
}: {
  sessions: SessionSummary[] | undefined;
  selectedSessionKey: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  // How much of a long list is unfolded is this row's own business, and it lives and
  // dies with the row: collapsing a project unmounts this, so reopening it starts folded.
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_COUNT);

  // A failure has one home now, the inventory stream's, so there is no per-project
  // error state here: an unreachable sidecar is reported once at the top of the list
  // rather than once per expanded row.
  if (!sessions) return <InlineStatus>Loading sessions…</InlineStatus>;
  if (sessions.length === 0) return <InlineStatus>No sessions</InlineStatus>;

  const visibleSessions = sessions.slice(0, visibleCount);
  const remaining = Math.max(0, sessions.length - visibleSessions.length);
  const nextBatch = Math.min(SESSION_BATCH_SIZE, remaining);

  return (
    <>
      <ul role="list" aria-label="Sessions" className="pb-1">
        {visibleSessions.map((session) => {
          const key = `${session.source}:${session.sessionId}`;
          const active = key === selectedSessionKey;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onSelect(session)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 w-full items-start gap-2 border-l-2 py-2 pr-3 pl-8 text-left hover:bg-muted/60 ${
                  active ? "border-primary bg-muted text-foreground" : "border-transparent"
                }`}
              >
                <ActivityDot activity={session.activity} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                    {session.title || session.sessionId}
                  </span>
                  <SessionMeta
                    source={session.source}
                    lastEventAt={session.lastEventAt}
                    activity={session.activity}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setVisibleCount((current) => current + SESSION_BATCH_SIZE)}
          className="flex min-h-11 w-full items-center px-8 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          Show {nextBatch} more ({remaining} remaining)
        </button>
      ) : null}
    </>
  );
}
