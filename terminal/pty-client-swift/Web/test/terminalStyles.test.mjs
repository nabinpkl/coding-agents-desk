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

test('the terminal viewport can shrink below its content in both profiles', () => {
  assert.match(css, /#terminal-stage,\s*\.split,\s*\.terminal-pane,\s*\.terminal-viewport\s*\{[^}]*min-height:\s*0;/s)
  assert.match(css, /\.terminal-pane\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/s)
})
