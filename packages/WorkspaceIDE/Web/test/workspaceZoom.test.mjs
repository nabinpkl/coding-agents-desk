import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWorkspaceZoom, normalizeWorkspaceZoom } from '../src/workspaceZoom.mjs'

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
