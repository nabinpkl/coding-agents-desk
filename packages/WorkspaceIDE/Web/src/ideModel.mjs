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
