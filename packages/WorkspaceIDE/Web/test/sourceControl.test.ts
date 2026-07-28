import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gitDecorationTone, sourceControlSections } from '../src/ideModel.ts'

const css = readFileSync(fileURLToPath(new URL('../ide.css', import.meta.url)), 'utf8')
const panel = readFileSync(fileURLToPath(new URL('../src/sidebar/sourceControl.ts', import.meta.url)), 'utf8')
const tree = readFileSync(fileURLToPath(new URL('../src/sidebar/tree.ts', import.meta.url)), 'utf8')

const entry = (relativePath, indexStatus, workTreeStatus) => ({
  relativePath,
  indexStatus,
  workTreeStatus,
})

test('ignored paths never reach Source Control', () => {
  const sections = sourceControlSections([
    entry('.build', null, '!'),
    entry('agent-feed/sidecar/node_modules', null, '!'),
    entry('README.md', null, 'M'),
  ])

  assert.deepEqual(sections.map((section) => section.id), ['changes'])
  assert.deepEqual(sections[0].rows.map((row) => row.path), ['README.md'])
})

test('entries are grouped by how they get resolved', () => {
  const sections = sourceControlSections([
    entry('src/app.ts', 'A', null),
    entry('README.md', null, 'M'),
    entry('notes.txt', null, '?'),
    entry('merge.txt', 'U', 'U'),
  ])

  assert.deepEqual(
    sections.map((section) => [section.id, section.rows.length]),
    [['conflicts', 1], ['staged', 1], ['changes', 1], ['untracked', 1]]
  )
  assert.equal(sections[0].rows[0].letters, 'UU')
  assert.equal(sections[0].rows[0].tone, 'conflicted')
})

test('a path staged and edited again appears under both, with its own letter each time', () => {
  const sections = sourceControlSections([entry('src/app.ts', 'M', 'M')])

  assert.deepEqual(sections.map((section) => section.id), ['staged', 'changes'])
  assert.deepEqual(sections.map((section) => section.rows[0].letters), ['M', 'M'])
})

test('rows split the filename from its directory so the name can win the squeeze', () => {
  const [section] = sourceControlSections([
    entry('client/AgentDeskClient/VoiceZIPAModel.onnx', null, 'M'),
    entry('Justfile', null, 'M'),
  ])

  assert.deepEqual(section.rows.map((row) => [row.name, row.directory]), [
    ['VoiceZIPAModel.onnx', 'client/AgentDeskClient'],
    ['Justfile', ''],
  ])
})

test('a clean tree produces no sections at all', () => {
  assert.deepEqual(sourceControlSections([]), [])
  assert.deepEqual(sourceControlSections(undefined), [])
  assert.deepEqual(sourceControlSections([entry('.build', null, '!')]), [])
})

test('tree decorations collapse a two-letter code to its strongest meaning', () => {
  assert.equal(gitDecorationTone('MM'), 'modified')
  assert.equal(gitDecorationTone('AM'), 'modified')
  assert.equal(gitDecorationTone('A'), 'added')
  assert.equal(gitDecorationTone('D'), 'deleted')
  assert.equal(gitDecorationTone('?'), 'untracked')
  assert.equal(gitDecorationTone('UU'), 'conflicted')
  assert.equal(gitDecorationTone('!'), 'ignored')
  assert.equal(gitDecorationTone(''), null)
  assert.equal(gitDecorationTone(null), null)
})

test('ignored tree rows are dimmed, and a conflict badge fills where others only tint', () => {
  assert.match(tree, /data-\[git=ignored\]:opacity-45/)
  // Every other state is a 15% tint; the conflict is the one that stops the eye.
  assert.match(panel, /group-data-\[tone=added\]:bg-git-added\/15/)
  assert.match(panel, /group-data-\[tone=conflicted\]:bg-git-conflicted(?!\/)/)
})

test('every git status colour is defined in both schemes', () => {
  const tokens = ['modified', 'added', 'untracked', 'deleted', 'conflicted']
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'))
  for (const token of tokens) {
    // Declared once in @theme so `bg-git-x` and `text-git-x` exist, then re-valued for dark: one
    // set of names, two sets of values, every utility following automatically.
    assert.match(css, new RegExp(`--color-git-${token}:\\s*#`), `light --color-git-${token}`)
    assert.match(dark, new RegExp(`--color-git-${token}:\\s*#`), `dark --color-git-${token}`)
  }
})
