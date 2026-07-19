const regions = new Set(['sidebar', 'editor'])

export function regionFromLocation(location) {
  const region = new URL(location.href).searchParams.get('region')
  return regions.has(region) ? region : null
}

export function normalizeProjection(snapshot, expectedRegion) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.region !== expectedRegion) return null
  if (expectedRegion === 'sidebar') {
    return {
      ...snapshot,
      workspaces: Array.isArray(snapshot.workspaces)
        ? snapshot.workspaces.map((workspace) => ({
          id: workspace.id ?? workspace.i,
          name: workspace.name ?? workspace.n,
          desktopOrdinal: workspace.desktopOrdinal ?? workspace.o ?? null,
          desktopAutoAssignEnabled: workspace.desktopAutoAssignEnabled ?? workspace.a ?? false,
        }))
        : [],
      tree: Array.isArray(snapshot.tree) ? snapshot.tree : [],
      gitEntries: Array.isArray(snapshot.gitEntries)
        ? snapshot.gitEntries.map((entry) => ({
          relativePath: entry.relativePath ?? entry.p,
          indexStatus: entry.indexStatus ?? entry.i,
          workTreeStatus: entry.workTreeStatus ?? entry.x,
        }))
        : [],
      capabilities: new Set(Array.isArray(snapshot.capabilities) ? snapshot.capabilities : []),
    }
  }
  return {
    ...snapshot,
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs : [],
    breadcrumb: Array.isArray(snapshot.breadcrumb) ? snapshot.breadcrumb : [],
  }
}

export function fileRenderIdentity(file) {
  if (!file) return null
  return JSON.stringify([
    file.id, file.kind, file.mode, file.renderToken ?? null,
  ])
}

export function orderedPathsAfterMove(paths, sourcePath, targetPath) {
  const source = paths.indexOf(sourcePath)
  const target = paths.indexOf(targetPath)
  if (source < 0 || target < 0 || source === target) return [...paths]
  const next = [...paths]
  const [moved] = next.splice(source, 1)
  next.splice(target, 0, moved)
  return next
}
