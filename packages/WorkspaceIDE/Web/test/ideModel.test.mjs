import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fileIconSpec,
  fileRenderIdentity,
  normalizeProjection,
  orderedPathsAfterMove,
} from '../src/ideModel.mjs'

test('sidebar normalizes compact wire workspaces and Git entries', () => {
  const projection = normalizeProjection({
    region: 'sidebar',
    workspaces: [{ i: 'w1', n: 'Workspace', o: 2, a: true }],
    tree: [],
    gitEntries: [{ p: 'README.md', i: 'M', x: ' ' }],
    capabilities: ['addWorkspace'],
  }, 'sidebar')
  assert.deepEqual(projection.workspaces, [{
    id: 'w1', name: 'Workspace', desktopOrdinal: 2, desktopAutoAssignEnabled: true,
  }])
  assert.deepEqual(projection.gitEntries, [{ relativePath: 'README.md', indexStatus: 'M', workTreeStatus: ' ' }])
  assert.equal(projection.capabilities.has('addWorkspace'), true)
})

test('region mismatch is rejected instead of crossing webview state', () => {
  assert.equal(normalizeProjection({ region: 'editor', tabs: [] }, 'sidebar'), null)
  assert.equal(normalizeProjection({ region: 'sidebar', tree: [] }, 'editor'), null)
})

test('tab reorder remains total and idempotent', () => {
  assert.deepEqual(orderedPathsAfterMove(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(orderedPathsAfterMove(['a', 'b'], 'missing', 'a'), ['a', 'b'])
})

test('file render identity ignores local keystrokes and changes for native refreshes', () => {
  const first = fileRenderIdentity({ id: 'a', kind: 'text', mode: 'edit', text: 'one', renderToken: 'one' })
  assert.equal(first, fileRenderIdentity({ id: 'a', kind: 'text', mode: 'edit', text: 'two', renderToken: 'one' }))
  assert.notEqual(first, fileRenderIdentity({ id: 'a', kind: 'text', mode: 'edit', text: 'two', renderToken: 'two' }))
  assert.notEqual(
    fileRenderIdentity({ id: 'd', kind: 'docx', mode: 'preview', renderToken: 'one' }),
    fileRenderIdentity({ id: 'd', kind: 'docx', mode: 'preview', renderToken: 'two' }),
  )
})

test('Explorer icons distinguish folders and curated file types', () => {
  assert.deepEqual(fileIconSpec('Sources', true), { shape: 'folder', tone: 'folder' })
  assert.deepEqual(fileIconSpec('.gitignore', false), { shape: 'file', tone: 'git' })
  assert.deepEqual(fileIconSpec('Package.swift', false), { shape: 'file', tone: 'swift' })
  assert.deepEqual(fileIconSpec('worker.py', false), { shape: 'file', tone: 'python' })
  assert.deepEqual(fileIconSpec('app.tsx', false), { shape: 'file', tone: 'typescript' })
  assert.deepEqual(fileIconSpec('README.md', false), { shape: 'file', tone: 'markdown' })
  assert.deepEqual(fileIconSpec('preview.png', false), { shape: 'file', tone: 'image' })
  assert.deepEqual(fileIconSpec('unknown.data', false), { shape: 'file', tone: 'default' })
})

test('Explorer icon matching is case insensitive and handles special filenames', () => {
  assert.deepEqual(fileIconSpec('DOCKERFILE', false), { shape: 'file', tone: 'docker' })
  assert.deepEqual(fileIconSpec('LICENSE.md', false), { shape: 'file', tone: 'muted' })
  assert.deepEqual(fileIconSpec('Package-Lock.JSON', false), { shape: 'file', tone: 'muted' })
  assert.deepEqual(fileIconSpec('.ENV.LOCAL', false), { shape: 'file', tone: 'environment' })
})
