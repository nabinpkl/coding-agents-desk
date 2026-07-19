import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const outputDirectories = [
  '../../Sources/WorkspaceFileViewer/Resources/viewer/dist',
  '../../Sources/WorkspaceIDE/Resources/ide/dist',
].map((path) => resolve(import.meta.dirname, path))

for (const outputDirectory of outputDirectories) {
  for (const name of readdirSync(outputDirectory)) {
    if (!name.endsWith('.js')) continue
    const file = resolve(outputDirectory, name)
    const source = readFileSync(file, 'utf8')
    writeFileSync(file, source.replace(/[ \t]+$/gm, ''))
  }
}
