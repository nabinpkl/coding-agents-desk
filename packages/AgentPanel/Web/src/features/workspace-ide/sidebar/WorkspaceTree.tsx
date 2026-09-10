// The explorer tree.
//
// Recursive components rather than a recursive DOM builder: the projection already carries the
// whole visible tree, so each level renders the children it was handed and nothing walks the
// sidecar per expansion.

import { ChevronRight } from "lucide-react";
import type { WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { FileIcon } from "@/features/workspace-ide/sidebar/FileIcon";
import { gitDecorationTone, type GitTone } from "@/features/workspace-ide/sidebar/gitTones";

/**
 * The colour each tone carries.
 *
 * Named here rather than as data attributes with a stylesheet, because the panel's palette is
 * Tailwind tokens and a second theming mechanism for one tree is a second place to look.
 */
const TONE_TEXT: Record<GitTone, string> = {
  modified: "text-amber-600 dark:text-amber-400",
  added: "text-emerald-600 dark:text-emerald-400",
  deleted: "text-rose-600 dark:text-rose-400",
  untracked: "text-sky-600 dark:text-sky-400",
  conflicted: "text-fuchsia-600 dark:text-fuchsia-400",
  ignored: "text-muted-foreground",
};

const ROW = "group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left"
  + " outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary"
  + " focus-visible:ring-inset active:bg-muted";

export function WorkspaceTree({
  nodes,
  activePath,
  onOpen,
  onToggle,
  nested = false,
}: {
  nodes: WorkspaceTreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onToggle: (path: string, expanded: boolean) => void;
  nested?: boolean;
}) {
  return (
    <ul
      role={nested ? "group" : "tree"}
      className={`m-0 list-none p-0 ${nested ? "pl-3.5" : ""}`}
    >
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          activePath={activePath}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  activePath,
  onOpen,
  onToggle,
}: {
  node: WorkspaceTreeNode;
  activePath: string | null;
  onOpen: (path: string) => void;
  onToggle: (path: string, expanded: boolean) => void;
}) {
  const tone = gitDecorationTone(node.gitStatus);
  const selected = node.path === activePath;
  return (
    <li role="treeitem" aria-expanded={node.isDirectory ? node.expanded : undefined}>
      <button
        type="button"
        aria-label={node.isDirectory
          ? `${node.expanded ? "Collapse" : "Expand"} ${node.name}`
          : `Open ${node.name}`}
        onClick={() => (node.isDirectory
          ? onToggle(node.path, !node.expanded)
          : onOpen(node.path))}
        className={`${ROW} ${selected ? "bg-muted" : ""} ${tone === "ignored" ? "opacity-45" : ""}`}
      >
        {/* A directory's chevron is its mark: a folder glyph beside it said the same thing twice,
            and dropping it lets the chevron take a size you can aim at while filenames stay
            aligned down one column. */}
        {node.isDirectory
          ? (
            <ChevronRight
              aria-hidden
              className={`size-4 shrink-0 text-muted-foreground transition-transform
                group-hover:text-foreground ${node.expanded ? "rotate-90" : ""}`}
            />
          )
          : <FileIcon name={node.name} />}
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{node.name}</span>
        {/* Ignored rows carry no badge: the dimming already says "not part of the repo", and a
            column of marks beside every build artefact drowns the handful of real changes. */}
        {tone && tone !== "ignored"
          ? (
            <span className={`ml-auto font-mono text-[11px] leading-none ${TONE_TEXT[tone]}`}>
              {(node.gitStatus ?? "").trim()}
            </span>
          )
          : null}
      </button>
      {node.isDirectory && node.expanded
        ? (
          <WorkspaceTree
            nodes={node.children}
            activePath={activePath}
            onOpen={onOpen}
            onToggle={onToggle}
            nested
          />
        )
        : null}
    </li>
  );
}
