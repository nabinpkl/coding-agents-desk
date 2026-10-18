// The tree the sidebar draws: the root listing, plus the listing of every expanded directory
// beneath it, decorated with git.
//
// Assembled here rather than in the panel because the alternative is the panel asking for one
// directory per expansion and stitching them, which is what the Swift did across a message bridge.
// One projection paints the whole visible tree, so a reader who expands three directories gets one
// answer rather than three round trips that arrive in any order.

import type { WorkspaceGitEntry, WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { listDirectory } from "@/workspace/workspaceFiles";
import { statusForPath } from "@/workspace/workspaceGit";

/**
 * How deep an expanded path may be before it is ignored.
 *
 * A client can expand any path it likes, and each expansion costs a directory read. This is the
 * bound on how much work one projection can be made to do, which matters because the caller is
 * unauthenticated.
 */
export const MAXIMUM_TREE_DEPTH = 32;

/**
 * Build the visible tree.
 *
 * A directory that fails to list -- deleted between the expansion and the read, or newly
 * unreadable -- yields an empty `children` rather than failing the projection. A tree that refuses
 * to draw because one directory disappeared is worse than a tree with one empty node in it, and the
 * next file event redraws it anyway.
 */
export async function buildTree(
  root: string,
  expandedPaths: readonly string[],
  gitEntries: readonly WorkspaceGitEntry[],
): Promise<WorkspaceTreeNode[]> {
  const expanded = new Set(expandedPaths);

  async function level(directory: string, depth: number): Promise<WorkspaceTreeNode[]> {
    let entries;
    try {
      entries = await listDirectory(root, directory);
    } catch {
      return [];
    }
    return Promise.all(
      entries.map(async (entry): Promise<WorkspaceTreeNode> => {
        const isExpanded = entry.isDirectory && expanded.has(entry.path) && depth + 1 < MAXIMUM_TREE_DEPTH;
        return {
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
          expanded: isExpanded,
          gitStatus: statusForPath(gitEntries, entry.path),
          // Carried rather than re-derived: the listing already paid for it, and a second stat here
          // would ask the filesystem the same question twice in one projection.
          modifiedAt: entry.modifiedAt,
          children: isExpanded ? await level(entry.path, depth + 1) : [],
        };
      }),
    );
  }

  return level("", 0);
}
