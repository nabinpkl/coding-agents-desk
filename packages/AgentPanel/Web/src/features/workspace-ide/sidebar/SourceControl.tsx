// The source-control section: what git has to say, grouped the way it gets resolved.

import { useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { WorkspaceGitEntry } from "@agentdesk/agent-feed-wire";
import { FileIcon } from "@/features/workspace-ide/sidebar/FileIcon";
import {
  sourceControlSections,
  TONE_BADGE,
  type SourceControlSection,
} from "@/features/workspace-ide/sidebar/gitTones";

export function SourceControl({
  entries,
  onOpen,
  selectedPath,
}: {
  entries: readonly WorkspaceGitEntry[];
  onOpen: (path: string) => void;
  /** The path whose content is showing beside the list, for a surface that shows one. */
  selectedPath?: string | null;
}) {
  const sections = sourceControlSections(entries);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  if (sections.length === 0) {
    return (
      <div className="grid justify-items-center gap-1 px-4 py-9 text-center text-muted-foreground">
        <span
          aria-hidden
          className="mb-1 grid size-7 place-items-center rounded-full bg-emerald-500/15
            text-emerald-600 dark:text-emerald-400"
        >
          <Check className="size-4" />
        </span>
        <p className="m-0 text-foreground">Working tree clean</p>
        <p className="m-0 text-xs">Nothing staged, changed, or untracked.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {sections.map((section) => (
        <Group
          key={section.id}
          section={section}
          collapsed={collapsed.has(section.id)}
          onToggle={() =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (!next.delete(section.id)) next.add(section.id);
              return next;
            })}
          onOpen={onOpen}
          selectedPath={selectedPath ?? null}
        />
      ))}
    </div>
  );
}

function Group({
  section,
  collapsed,
  onToggle,
  onOpen,
  selectedPath,
}: {
  section: SourceControlSection;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (path: string) => void;
  selectedPath: string | null;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section>
      {/* Sticky and opaque: rows scroll underneath it, and a translucent header would smear them. */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${section.title}`}
        onClick={onToggle}
        className={`sticky top-0 z-10 flex w-full items-center gap-1.5 bg-background px-1.5 py-1
          text-left text-[11px] uppercase tracking-wide outline-none
          focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset
          ${section.id === "conflicts"
            ? "text-fuchsia-600 dark:text-fuchsia-400"
            : "text-muted-foreground hover:text-foreground"}`}
      >
        <Chevron aria-hidden className="size-3.5 shrink-0" />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{section.title}</span>
        <span
          className="ml-auto min-w-[17px] rounded-full bg-muted px-1.5 py-px text-center
            font-mono text-[10px] tracking-normal text-muted-foreground"
        >
          {section.rows.length}
        </span>
      </button>
      {collapsed
        ? null
        : (
          <ul aria-label={section.title} className="m-0 list-none p-0">
            {section.rows.map((row) => (
              <li key={`${section.id}:${row.path}`}>
                <button
                  type="button"
                  title={row.path}
                  aria-label={`Open ${row.path}`}
                  aria-current={row.path === selectedPath ? "true" : undefined}
                  onClick={() => onOpen(row.path)}
                  className={`group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left
                    outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary
                    focus-visible:ring-inset active:bg-muted
                    ${row.path === selectedPath ? "bg-muted" : ""}`}
                >
                  <span
                    className={`grid h-[17px] min-w-[18px] shrink-0 place-items-center rounded px-1
                      font-mono text-[10px] leading-none ${TONE_BADGE[row.tone]}`}
                  >
                    {row.letters}
                  </span>
                  <FileIcon name={row.name} />
                  <span
                    className={`min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap
                      ${row.tone === "deleted" ? "line-through" : ""}`}
                  >
                    {row.name}
                  </span>
                  {/* The directory is context, so it yields first and the filename survives the
                      squeeze: a zero basis means it only ever occupies leftover space. */}
                  <span
                    className="min-w-0 flex-1 basis-0 overflow-hidden text-ellipsis whitespace-nowrap
                      text-[11px] text-muted-foreground"
                  >
                    {row.directory}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
