// The order the explorer draws its rows in.
//
// Two orders, and one of them is decided somewhere else on purpose. `listDirectory` on the sidecar
// already sorts directories first and then by name with numeric collation, so "name" is what the
// projection arrives in and re-sorting it here would put a second collation in the tree that can
// disagree with the first. `modified` is the one the projection cannot know about, because it is a
// fact about how this reader is reading rather than about the workspace.

import type { WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";

/** Which order the rows of one directory are in. */
export type TreeOrder = "name" | "modified";

/** Whether a stored value is one of the two orders, rather than something that casts to it. */
export function isTreeOrder(value: unknown): value is TreeOrder {
  return value === "name" || value === "modified";
}

/**
 * One directory's rows, in the reader's order.
 *
 * Folders stay above files in both, which is not a preference: a file interleaved between two
 * folders a reader is opening is a tree that has stopped reading as a tree. What moves is the order
 * inside each group.
 *
 * Ties in `modified` keep the order the rows arrived in, and that order is already name order, so
 * two files written in the same second stay alphabetical without a second comparison to say so.
 * `Array.prototype.sort` is stable, which is the whole mechanism.
 */
export function sortSiblings(nodes: readonly WorkspaceTreeNode[], order: TreeOrder): WorkspaceTreeNode[] {
  if (order === "name") return [...nodes];
  return [...nodes].sort(mostRecentlyChanged);
}

function mostRecentlyChanged(left: WorkspaceTreeNode, right: WorkspaceTreeNode): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  if (left.modifiedAt === right.modifiedAt) return 0;
  return right.modifiedAt - left.modifiedAt;
}
