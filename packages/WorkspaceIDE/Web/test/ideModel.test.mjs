import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fileIconShape,
  fileIconSpec,
  fileRenderIdentity,
  normalizeProjection,
  orderedPathsAfterMove,
} from '../src/ideModel.mjs'
import { extensionIcons, filenameIcons, iconShapes } from '../src/generated/fileIcons.mjs'

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

const iconFor = (name) => fileIconSpec(name).icon

test('every extension resolves to an icon this bundle actually carries', () => {
  for (const icon of new Set(Object.values(extensionIcons).concat(Object.values(filenameIcons)))) {
    assert.ok(fileIconShape(icon), `no shape generated for icon "${icon}"`)
  }
  for (const [icon, shape] of Object.entries(iconShapes)) {
    assert.match(shape.viewBox, /^-?\d+ -?\d+ \d+ \d+$/, `bad viewBox on "${icon}"`)
    assert.ok(shape.body.includes('<'), `empty body on "${icon}"`)
  }
})

test('gradient ids are namespaced, so one icon cannot repaint another', () => {
  for (const [icon, shape] of Object.entries(iconShapes)) {
    for (const [, id] of shape.body.matchAll(/\bid="([^"]+)"/g)) {
      assert.ok(id.startsWith(`${icon}-`), `"${icon}" declares an unprefixed id "${id}"`)
    }
    for (const [, reference] of shape.body.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(reference.startsWith(`${icon}-`), `"${icon}" references a foreign id "${reference}"`)
    }
  }
})

test('file rows take the icon of their extension', () => {
  assert.equal(iconFor('Package.swift'), 'swift')
  assert.equal(iconFor('worker.py'), 'python')
  assert.equal(iconFor('main.rs'), 'rust')
  assert.equal(iconFor('README.md'), 'readme')
  assert.equal(iconFor('preview.png'), 'image')
  // A distinct icon per type is the point: React beside plain TypeScript, npm beside plain JSON.
  assert.equal(iconFor('app.tsx'), 'react_ts')
  assert.equal(iconFor('app.ts'), 'typescript')
  assert.equal(iconFor('package.json'), 'nodejs')
  assert.equal(iconFor('tsconfig.json'), 'tsconfig')
  assert.equal(iconFor('settings.json'), 'json')
})

test('an unknown type gets no icon rather than a borrowed one', () => {
  assert.equal(iconFor('capture.xyzzy'), null)
  assert.equal(iconFor('no-extension-at-all'), null)
  assert.equal(iconFor(''), null)
  assert.equal(iconFor(undefined), null)
})

test('icon matching is case insensitive, and a whole filename beats an extension', () => {
  assert.equal(iconFor('DOCKERFILE'), 'docker')
  assert.equal(iconFor('Justfile'), 'just')
  assert.equal(iconFor('.GITIGNORE'), 'git')
  assert.equal(iconFor('LICENSE.md'), 'license')
  assert.equal(iconFor('other.md'), 'markdown')
})

test('a longer extension wins, so a compose file is not just YAML', () => {
  assert.equal(iconFor('deploy.docker-compose.yml'), 'docker')
  assert.equal(iconFor('deploy.yml'), 'yaml')
})
