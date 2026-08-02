import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../src/terminal.css', import.meta.url)), 'utf8')

test('hiding the singleSession tab strip leaves the stage a growable row', () => {
  // `display: none` drops the tab strip out of the grid, so the stage auto-places into the first
  // row. If that row stays `auto` the pane's percentage height resolves to content and the
  // terminal viewport collapses to zero height: no settled capacity, no ownership claim, blank pane.
  assert.match(css, /\[data-profile="singleSession"\]\s*#terminal-tabs\s*\{\s*display:\s*none;/)
  assert.match(
    css,
    /#terminal-workspace-root\[data-profile="singleSession"\]\s*\{\s*grid-template-rows:\s*minmax\(0,\s*1fr\);/
  )
})

test('the terminal chrome follows the system appearance', () => {
  // Neither native shell pushes an appearance into the webview, so a pinned `color-scheme: dark` was
  // the whole reason a light-mode Mac framed its terminal in black.
  assert.match(css, /color-scheme:\s*light dark;/)
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/)
})

test('every painted surface reads a token, so one override flips the whole scheme', () => {
  // A literal left behind in a rule survives the dark override and shows up as a light-mode hole.
  const outsideTokenBlocks = css.replaceAll(/:root\s*\{[^}]*\}/g, '')
  assert.doesNotMatch(outsideTokenBlocks, /#[0-9a-f]{3,8}(?![\w-])/i)
})

test('the terminal viewport can shrink below its content in both profiles', () => {
  assert.match(css, /#terminal-stage,\s*\.split,\s*\.terminal-pane,\s*\.terminal-viewport\s*\{[^}]*min-height:\s*0;/s)
  assert.match(css, /\.terminal-pane\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/s)
})
