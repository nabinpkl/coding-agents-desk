"use client";

// Scratch chats in the grouped project list: one fold, at the bottom, instead of a project row per
// chat.
//
// Each chat has a folder of its own, so the catalog lists each one as a project. Grouped by
// project, that is a list of folders called "Scratch" with one session in each, between the real
// projects; the fold keeps them together and out of the way, and names each by its own folder,
// which is made from the chat's first message.

import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ProjectSummary } from "@agentdesk/agent-feed-wire";

/** A scratch chat's folder as the fold lists it: by the folder's own name. */
export function scratchItemProject(project: ProjectSummary): ProjectSummary {
  return { ...project, displayName: project.projectPath.split("/").pop() || project.displayName };
}

/** Folded by default and not remembered: it is a way back to old chats, not a view anyone reads. */
export function ScratchProjects({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground"
      >
        <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        Scratch ({count})
      </button>
      {open ? (
        <ul role="list" aria-label="Scratch chats">
          {children}
        </ul>
      ) : null}
    </div>
  );
}
