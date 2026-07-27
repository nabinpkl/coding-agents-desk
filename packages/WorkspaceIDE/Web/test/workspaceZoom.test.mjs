import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyWorkspaceZoom, normalizeWorkspaceZoom } from '../src/workspaceZoom.mjs'

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')
const viewerCss = read('viewer.css')
const ideCss = read('ide.css')
const ideHtml = read('ide.html')

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

test('the IDE root is not a flex item, or zooming out would squash it', () => {
  // viewer.css ships `body { display: flex }` for the standalone viewer, and ide.html loads both
  // stylesheets. As a flex item the zoomed-out root (height: 100/scale%) shrinks back to the
  // viewport before the transform runs, so the sidebar only paints `scale` of the window height.
  assert.match(viewerCss, /body\s*\{[^}]*display:\s*flex;/s)
  assert.match(ideCss, /body\s*\{[^}]*display:\s*block;/s)
  assert.ok(
    ideHtml.indexOf('viewer.css') < ideHtml.indexOf('ide.css'),
    'ide.css must load after viewer.css to win the body display'
  )
})
