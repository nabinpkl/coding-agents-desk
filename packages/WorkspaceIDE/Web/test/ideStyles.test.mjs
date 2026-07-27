import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../ide.css', import.meta.url)), 'utf8')

test('semantic hidden state wins over component display rules', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/)
})

test('the sidebar panel keeps the growable row when the alert above it is hidden', () => {
  assert.match(css, /\.ide-sidebar-panel\s*\{[^}]*grid-row:\s*4;/s)
  assert.match(css, /grid-template-rows:\s*auto auto auto minmax\(0, 1fr\);/)
})

test('Explorer uses compact semantic icons at every sidebar width', () => {
  assert.match(css, /\.ide-file-icon\s*\{[^}]*width:\s*16px;/s)
  assert.doesNotMatch(css, /@container sidebar[^}]*\.ide-file-icon\s*\{\s*display:\s*none;/s)
  // The generated icons paint themselves, so a leftover tone rule would only ever fight them.
  assert.doesNotMatch(css, /data-tone='(folder|swift|python|javascript|markdown)'/)
  assert.doesNotMatch(css, /--ide-icon-/)
})

test('section buttons are stroked glyphs that never fall back to a text label', () => {
  assert.match(css, /\.ide-activity-button svg\s*\{[^}]*stroke:\s*currentColor;/s)
  assert.match(css, /\.ide-activity-button svg\s*\{[^}]*fill:\s*none;/s)
  // The old narrow-sidebar rule shrank the label to its first letter; there is no label now.
  assert.doesNotMatch(css, /::first-letter/)
})
