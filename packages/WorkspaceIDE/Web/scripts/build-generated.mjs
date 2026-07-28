// Builds both webview documents into a staging directory that `publish-generated-tree.mjs` then
// copies into the Swift package resources.
//
// Two separate Vite builds rather than one multi-entry build: the viewer ships in
// WorkspaceFileViewer and the IDE in WorkspaceIDE, as independent resource trees that each want a
// self-contained `index.html` + `assets/`. One shared build would force both targets to carry the
// other's chunks.

import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { build } from 'vite'

const webRoot = resolve(import.meta.dirname, '..')

const documents = [
  { name: 'viewer', entry: 'index.html' },
  // Vite names the output after its input, and the scheme handler serves `index.html` for the bare
  // host, so the IDE's document is renamed once the build lands.
  { name: 'ide', entry: 'ide.html', emitAs: 'index.html' },
]

async function normalizeJavaScript(directory) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const file = resolve(entry.parentPath, entry.name)
    const source = await readFile(file, 'utf8')
    const normalized = source.replace(/[ \t]+$/gm, '')
    if (normalized !== source) await writeFile(file, normalized)
  }
}

async function buildDocument({ entry, name, emitAs }, stagingDirectory) {
  const outDir = resolve(stagingDirectory, name)
  await build({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.mjs'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve(webRoot, entry) } },
  })
  if (emitAs) await rename(resolve(outDir, entry), resolve(outDir, emitAs))
  await normalizeJavaScript(outDir)
}

const [stagingDirectory, ...unexpected] = process.argv.slice(2)
if (!stagingDirectory || unexpected.length !== 0) {
  throw new Error('usage: build-generated.mjs <empty-staging-directory>')
}
const staging = resolve(stagingDirectory)
if ((await readdir(staging)).length !== 0) {
  throw new Error(`WorkspaceIDE staging directory must be empty: ${staging}`)
}
// Sequential: two concurrent Vite builds against one root race on the shared dependency cache.
for (const document of documents) await buildDocument(document, staging)
