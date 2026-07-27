import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyWorkspaceZoom, normalizeWorkspaceZoom } from '../src/workspaceZoom.mjs'

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')
const stylesheetsOf = (html) => [...html.matchAll(/<link[^>]+href="[^"]*\/([\w.-]+\.css)"/g)].map(([, name]) => name)

test('workspace zoom scales a region while preserving its physical viewport coverage', () => {
  const root = { style: {} }

  const scale = applyWorkspaceZoom(root, 1.25)

  assert.equal(scale, 1.25)
  assert.equal(root.style.transform, 'scale(1.25)')
  assert.equal(root.style.transformOrigin, 'top left')
  assert.equal(root.style.width, '80%')
  assert.equal(root.style.height, '80%')
})

test('workspace zoom rejects invalid values and remains within the native range', () => {
  assert.equal(normalizeWorkspaceZoom(Number.NaN), 1)
  assert.equal(normalizeWorkspaceZoom(0.1), 0.6)
  assert.equal(normalizeWorkspaceZoom(4), 2)
})

test('each document loads exactly one stylesheet that lays itself out', () => {
  // Zooming out sizes a region's root to 100/scale% so scaling it back down covers the window.
  // That collapses the moment a second stylesheet turns the root into a flex or grid item, because
  // such an item shrinks to fit — which is what a shared stylesheet laying out `body` would do.
  assert.deepEqual(stylesheetsOf(read('index.html')), ['file-content.css', 'viewer.css'])
  assert.deepEqual(stylesheetsOf(read('ide.html')), ['file-content.css', 'ide.css'])
})

/// Every selector the sheet declares, comments stripped and `@media` blocks flattened, so the check
/// below reads real selectors rather than whatever a regex happens to bump into.
function selectorsOf(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .flatMap((block) => block.split('{').slice(0, -1))
    .flatMap((selector) => selector.split(','))
    .map((selector) => selector.replace(/@media[^{]*/g, '').trim())
    .filter(Boolean)
}

test('the shared content stylesheet never lays out the document that loads it', () => {
  const shared = selectorsOf(read('file-content.css'))
  const layoutTargets = shared.filter((selector) => /(^|\s)(html|body)(\s|$|[.:[])/.test(selector))
  assert.deepEqual(layoutTargets, [], 'file-content.css must not style html or body')
  // Nor reach for the standalone viewer's container, which only that one document has.
  assert.deepEqual(shared.filter((selector) => selector.includes('#content')), [])
  // Both roots are still laid out, by their own documents, and they disagree on purpose.
  assert.match(read('viewer.css'), /body\s*\{[^}]*display:\s*flex;/s)
  assert.match(read('ide.css'), /#workspace-ide\s*\{[^}]*display:\s*grid;/s)
})
