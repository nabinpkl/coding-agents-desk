/**
 * The tab order after dragging one tab onto another.
 *
 * Its own module because it is the one piece of the tab strip that can be reasoned about without a
 * DOM, and the reorder it produces is refused by the sidecar unless it is a permutation of what is
 * open. A move that names a path not in the list returns the list unchanged rather than inventing
 * an order.
 */
export function orderedPathsAfterMove(
  paths: readonly string[],
  sourcePath: string,
  targetPath: string,
): string[] {
  const source = paths.indexOf(sourcePath);
  const target = paths.indexOf(targetPath);
  if (source < 0 || target < 0 || source === target) return [...paths];
  const next = [...paths];
  const [moved] = next.splice(source, 1);
  next.splice(target, 0, moved!);
  return next;
}
