import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import { build } from 'esbuild'

async function normalizeJavaScript(outputDirectory) {
  for (const name of await readdir(outputDirectory)) {
    if (!name.endsWith('.js')) continue
    const file = resolve(outputDirectory, name)
    const source = await readFile(file, 'utf8')
    const normalized = source.replace(/[ \t]+$/gm, '')
    if (normalized !== source) await writeFile(file, normalized)
  }
}

async function buildBundle({ webRoot, entryPoint, entryName, outputDirectory }) {
  await mkdir(outputDirectory, { recursive: true })
  await build({
    absWorkingDir: webRoot,
    bundle: true,
    entryNames: entryName,
    entryPoints: [entryPoint],
    format: 'esm',
    minify: true,
    outdir: outputDirectory,
    splitting: true,
  })
  await normalizeJavaScript(outputDirectory)
}

async function buildGeneratedWorkspaceIDE(stagingDirectory) {
  const webRoot = resolve(import.meta.dirname, '..')
  const staging = resolve(stagingDirectory)
  const existingEntries = await readdir(staging)
  if (existingEntries.length !== 0) {
    throw new Error(`WorkspaceIDE staging directory must be empty: ${staging}`)
  }

  const viewer = resolve(staging, 'viewer')
  const ide = resolve(staging, 'ide')
  await Promise.all([
    mkdir(viewer, { recursive: true }),
    mkdir(ide, { recursive: true }),
  ])
  await Promise.all([
    copyFile(resolve(webRoot, 'index.html'), resolve(viewer, 'index.html')),
    copyFile(resolve(webRoot, 'viewer.css'), resolve(viewer, 'viewer.css')),
    copyFile(resolve(webRoot, 'ide.html'), resolve(ide, 'index.html')),
    copyFile(resolve(webRoot, 'ide.css'), resolve(ide, 'ide.css')),
    copyFile(resolve(webRoot, 'viewer.css'), resolve(ide, 'viewer.css')),
  ])
  await Promise.all([
    buildBundle({
      webRoot,
      entryPoint: 'src/viewerBootstrap.mjs',
      entryName: 'viewer',
      outputDirectory: resolve(viewer, 'dist'),
    }),
    buildBundle({
      webRoot,
      entryPoint: 'src/ide.mjs',
      entryName: 'ide',
      outputDirectory: resolve(ide, 'dist'),
    }),
  ])
}

const [stagingDirectory, ...unexpected] = process.argv.slice(2)
if (!stagingDirectory || unexpected.length !== 0) {
  throw new Error('usage: build-generated.mjs <empty-staging-directory>')
}
await buildGeneratedWorkspaceIDE(stagingDirectory)
