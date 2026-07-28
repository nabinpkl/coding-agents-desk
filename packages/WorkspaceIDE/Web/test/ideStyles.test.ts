import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/// Styling moved onto the markup with Tailwind, so these assertions read the component that makes
/// each decision rather than a stylesheet that no longer holds it. `ide.css` keeps only the theme,
/// the document base, and the few rules that style DOM this project does not author.
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

const css = read('ide.css')
const entry = read('src/ide.ts')
const sidebar = read('src/sidebar/mount.ts')
const activity = read('src/sidebar/activityBar.ts')
const tree = read('src/sidebar/tree.ts')
const dom = read('src/dom.ts')

test('semantic hidden state wins over component display rules', () => {
  // Unlayered, so it outranks the utilities: a `flex` class must not resurrect a hidden element.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/)
  assert.doesNotMatch(css, /@layer[^{]*\{[^}]*\[hidden\]/s)
})

test('every region pins its scrolling pane to the growable row', () => {
  // A hidden sibling stops being a grid item, so auto-placement would slide these up into an
  // `auto` row and size them to their content instead of the window.
  assert.match(entry, /grid-rows-\[auto_auto_auto_minmax\(0,1fr\)\]/)
  assert.match(entry, /grid-rows-\[36px_34px_auto_minmax\(0,1fr\)\]/)
  assert.match(sidebar, /row-start-4/)
  const editor = read('src/editor/mount.ts')
  assert.equal(editor.match(/row-start-4/g)?.length, 2, 'file pane and empty state both pin row 4')
})

test('a directory is marked by its chevron alone, in the icon column', () => {
  // Same 16px box as a file icon, so names align down one column whichever kind of row it is.
  assert.match(dom, /export function chevron[\s\S]*?size-4[\s\S]*?stroke-\[1\.7\]/)
  assert.match(dom, /export function chevron[\s\S]*?data-\[expanded=true\]:rotate-90/)
  assert.match(dom, /export function fileIcon[\s\S]*?size-4/)
})

test('section buttons are stroked glyphs that never fall back to a text label', () => {
  assert.match(activity, /fill-none stroke-current/)
  // The old narrow-sidebar rule shrank the label to its first letter; there is no label now.
  assert.doesNotMatch(css, /::first-letter/)
  assert.doesNotMatch(activity, /::first-letter/)
})

test('ignored tree rows are dimmed rather than badged in a status colour', () => {
  assert.match(tree, /data-\[git=ignored\]:opacity-45/)
  assert.match(tree, /tone !== 'ignored'/)
})

test('generated file icons paint themselves, with no tone rules left to fight them', () => {
  assert.doesNotMatch(css, /--ide-icon-/)
  assert.doesNotMatch(css, /data-tone/)
})
