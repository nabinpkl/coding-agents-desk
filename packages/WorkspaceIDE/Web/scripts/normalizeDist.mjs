import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const outputDirectory = resolve(import.meta.dirname, '../../Sources/WorkspaceFileViewer/Resources/viewer/dist')
for (const name of readdirSync(outputDirectory)) {
  if (!name.endsWith('.js')) continue
  const file = resolve(outputDirectory, name)
  const source = readFileSync(file, 'utf8')
  writeFileSync(file, source.replace(/[ \t]+$/gm, ''))
}
