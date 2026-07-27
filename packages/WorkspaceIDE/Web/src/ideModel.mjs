const regions = new Set(['sidebar', 'editor'])

const filenameTones = Object.freeze({
  '.gitattributes': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.env': 'environment',
  '.env.local': 'environment',
  '.env.production': 'environment',
  'cargo.lock': 'muted',
  dockerfile: 'docker',
  license: 'muted',
  'license.md': 'muted',
  'license.txt': 'muted',
  'package-lock.json': 'muted',
  'package.resolved': 'muted',
  'podfile.lock': 'muted',
})

const extensionTones = Object.freeze({
  swift: 'swift', py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'javascript', jsonc: 'javascript',
  yaml: 'config', yml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config',
  md: 'markdown', markdown: 'markdown', rst: 'markdown',
  html: 'html', htm: 'html', xml: 'muted', plist: 'muted',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  txt: 'default', text: 'default', log: 'default',
  rb: 'ruby', go: 'go', rs: 'rust',
  c: 'code', h: 'code', cpp: 'code', cc: 'code', cxx: 'code',
  hpp: 'code', m: 'code', mm: 'code',
  java: 'java', kt: 'java', kts: 'java',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image',
  heic: 'image', bmp: 'image', ico: 'image', icns: 'image',
  pdf: 'pdf', docx: 'document',
  zip: 'muted', tar: 'muted', gz: 'muted', tgz: 'muted', bz2: 'muted', xz: 'muted',
  '7z': 'muted', rar: 'muted', lock: 'muted',
})

export function fileIconSpec(name, isDirectory) {
  if (isDirectory) return { shape: 'folder', tone: 'folder' }
  const lowerName = String(name ?? '').toLowerCase()
  const namedTone = filenameTones[lowerName]
  if (namedTone) return { shape: 'file', tone: namedTone }
  const dot = lowerName.lastIndexOf('.')
  const extension = dot >= 0 ? lowerName.slice(dot + 1) : ''
  return { shape: 'file', tone: extensionTones[extension] ?? 'default' }
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
