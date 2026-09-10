// Builds the viewer document into a staging directory that `publish-generated-tree.mjs` then
// copies into the Swift package resources.
//
// It used to build two: the retained single-file viewer, and the IDE's paired sidebar/editor
// regions. The IDE is the Agent Panel and the sidecar now (ADR-0115), so one document is left, and
// the loop below is kept rather than inlined because the shape is what makes adding a second one
// cheap again.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { build } from 'vite'

const webRoot = resolve(import.meta.dirname, '..')

const documents = [{ name: 'viewer', entry: 'index.html' }]

async function normalizeJavaScript(directory) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const file = resolve(entry.parentPath, entry.name)
    const source = await readFile(file, 'utf8')
    const normalized = source.replace(/[ \t]+$/gm, '')
    if (normalized !== source) await writeFile(file, normalized)
  }
}

async function buildDocument({ entry, name }, stagingDirectory) {
  const outDir = resolve(stagingDirectory, name)
  await build({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.mjs'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve(webRoot, entry) } },
  })
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
// Sequential: two concurrent Vite builds against one root would race on the shared dependency cache.
for (const document of documents) await buildDocument(document, staging)
