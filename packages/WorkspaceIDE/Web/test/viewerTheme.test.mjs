import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFixture = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const css = readFixture('../viewer.css')
const viewer = readFixture('../src/viewer.mjs')

test('viewer exposes light and dark system theme variables', () => {
  assert.match(css, /color-scheme:\s*light dark/)
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/)
  assert.match(css, /--peek-fade:/)
  assert.match(css, /--danger-bg:/)
  assert.match(css, /--tok-keyword:/)
})

test('notebook colors come from theme variables instead of dark literals', () => {
  assert.match(css, /\.nb-stream-stderr\s*\{\s*background:\s*var\(--stderr-bg\);\s*color:\s*var\(--stderr-fg\);/)
  assert.match(css, /\.nb-error\s*\{\s*background:\s*var\(--danger-bg\);\s*color:\s*var\(--danger-fg\);/)
  assert.match(css, /linear-gradient\(transparent,\s*var\(--peek-fade\)\)/)
})

test('Mermaid render theme follows the system color scheme', () => {
  assert.match(viewer, /function mermaidTheme\(\)/)
  assert.match(viewer, /prefers-color-scheme:\s*dark/)
  assert.doesNotMatch(viewer, /theme:\s*'dark'/)
})

test('CodeMirror editor theme follows the system color scheme', () => {
  assert.doesNotMatch(viewer, /@codemirror\/theme-one-dark/)
  assert.match(viewer, /const editorTheme = new Compartment\(\)/)
  assert.match(viewer, /editorTheme\.of\(editorThemeExtensions\(\)\)/)
  assert.match(viewer, /EditorView\.theme\(/)
  assert.match(viewer, /dark:\s*isDarkSystemTheme\(\)/)
  assert.match(viewer, /editorTheme\.reconfigure\(editorThemeExtensions\(\)\)/)
  assert.match(viewer, /var\(--bg\)/)
  assert.match(viewer, /var\(--tok-comment\)/)
})

test('file preview content does not enter edit mode on double-click', () => {
  assert.doesNotMatch(viewer, /addEventListener\('dblclick'/)
  assert.doesNotMatch(viewer, /type:\s*'edit'/)
})

test('native chrome receives one content-aware zoom contract', () => {
  assert.match(viewer, /export function installFileSurface/)
  assert.match(viewer, /const surface = \{ render, setTextZoom, zoomIn, zoomOut,/)
  assert.doesNotMatch(viewer, /zoomDocument(In|Out)/)
})
