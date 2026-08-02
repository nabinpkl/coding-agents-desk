import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const main = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/terminal.css', import.meta.url)), 'utf8')

test('a running session with no clients is offered as a killable orphan', () => {
  // Nothing reaps a detached session on a timer any more - that is what lets a terminal survive a
  // host rebuild - so the drawer is the only place one can be found and deliberately ended.
  assert.match(main, /session\.state === 'running' && session\.clientCount === 0/)
  assert.match(main, /intent: 'killSession', sessionName: session\.name/)
})

test('the orphan marker is styled as a resting state, not an error', () => {
  // Detached is what surviving a restart looks like; painting it as a fault would train the user to
  // kill exactly the sessions the design is trying to keep.
  assert.match(css, /\.drawer-orphan\s*\{[^}]*color:\s*var\(--muted\)/s)
  assert.doesNotMatch(css, /\.drawer-orphan\s*\{[^}]*color:\s*(red|#[0-9a-f]{3,8})/is)
})
