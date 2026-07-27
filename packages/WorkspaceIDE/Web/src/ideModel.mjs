import { extensionIcons, filenameIcons, iconShapes } from './generated/fileIcons.mjs'

const regions = new Set(['sidebar', 'editor'])

/// Which icon a row draws. `null` means "no icon of its own": the caller falls back to the plain
/// document outline, which is what an unrecognised extension should look like rather than a
/// misleading borrowed logo.
///
/// A whole filename beats an extension (`package.json` is the npm mark, not the generic JSON one),
/// and a longer extension beats a shorter one (`docker-compose.yml` before `yml`) — the same
/// precedence VS Code resolves icon themes with, so a file looks the way people expect.
export function fileIconSpec(name, isDirectory = false, isExpanded = false) {
  if (isDirectory) return { icon: isExpanded ? 'folder-open' : 'folder' }
  const lowerName = String(name ?? '').toLowerCase()
  const named = filenameIcons[lowerName]
  if (named) return { icon: named }
  const segments = lowerName.split('.')
  for (let start = 1; start < segments.length; start += 1) {
    const icon = extensionIcons[segments.slice(start).join('.')]
    if (icon) return { icon }
  }
  return { icon: null }
}

export function fileIconShape(icon) {
  return iconShapes[icon] ?? null
}

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

// Porcelain's unmerged combinations. Both columns carry a letter, so they would otherwise be
// filed under both Staged and Changes; a conflict is one thing to resolve, not two edits.
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

const statusTones = Object.freeze({
  M: 'modified', R: 'modified', C: 'modified', T: 'modified',
  A: 'added', D: 'deleted', U: 'conflicted', '?': 'untracked',
})

/// Highest severity first, mirroring the host's `GitFileStatus.severity`, so a two-letter code
/// collapses to the same meaning the macOS sidebar shows.
const toneSeverity = ['U', 'M', 'A', 'D']

export function gitStatusTone(letter) {
  return statusTones[letter] ?? 'modified'
}

/// The decoration a tree row wears. Ignored wins outright: those rows are dimmed rather than
/// badged, because "excluded from the repo" is not a change the reader can act on.
export function gitDecorationTone(status) {
  const code = String(status ?? '').trim()
  if (!code) return null
  if (code.includes('!')) return 'ignored'
  if (conflictCodes.has(code)) return 'conflicted'
  if (code.includes('?')) return 'untracked'
  const letter = toneSeverity.find((candidate) => code.includes(candidate))
  return letter ? gitStatusTone(letter) : 'modified'
}

/// Groups working-tree entries the way they are resolved: conflicts first, then what is staged,
/// then unstaged edits, then new files. A path edited both in the index and the worktree appears
/// under both, which is the truth git reports and what the reader has to act on twice. Ignored
/// paths are dropped - they exist on the wire only to dim the Explorer.
export function sourceControlSections(entries) {
  const conflicts = []
  const staged = []
  const changes = []
  const untracked = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = typeof entry?.relativePath === 'string' ? entry.relativePath : ''
    if (!path) continue
    const index = entry.indexStatus ?? ''
    const workTree = entry.workTreeStatus ?? ''
    if (workTree === '!' || index === '!') continue
    if (conflictCodes.has(`${index}${workTree}`)) {
      conflicts.push(sourceControlRow(path, `${index}${workTree}`, 'conflicted'))
      continue
    }
    if (workTree === '?') {
      untracked.push(sourceControlRow(path, '?', 'untracked'))
      continue
    }
    if (index) staged.push(sourceControlRow(path, index, gitStatusTone(index)))
    if (workTree) changes.push(sourceControlRow(path, workTree, gitStatusTone(workTree)))
  }
  return [
    { id: 'conflicts', title: 'Merge Conflicts', rows: conflicts },
    { id: 'staged', title: 'Staged Changes', rows: staged },
    { id: 'changes', title: 'Changes', rows: changes },
    { id: 'untracked', title: 'Untracked', rows: untracked },
  ].filter((section) => section.rows.length > 0)
}

function sourceControlRow(path, letters, tone) {
  const cut = path.lastIndexOf('/')
  return {
    path,
    name: cut < 0 ? path : path.slice(cut + 1),
    directory: cut < 0 ? '' : path.slice(0, cut),
    letters,
    tone,
  }
}
