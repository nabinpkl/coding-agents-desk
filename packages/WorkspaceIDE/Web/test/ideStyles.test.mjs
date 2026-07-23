import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../ide.css', import.meta.url)), 'utf8')

test('semantic hidden state wins over component display rules', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/)
})

test('Explorer uses compact semantic icons at every sidebar width', () => {
  assert.match(css, /\.ide-file-icon\s*\{[^}]*width:\s*16px;/s)
  assert.match(css, /\.ide-file-icon\[data-tone='folder'\]\s*\{\s*color:\s*var\(--ide-icon-folder\);/)
  assert.doesNotMatch(css, /@container sidebar[^}]*\.ide-file-icon\s*\{\s*display:\s*none;/s)
})
