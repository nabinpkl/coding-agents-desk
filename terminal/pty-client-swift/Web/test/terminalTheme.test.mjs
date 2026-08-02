import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { prefersDarkScheme, terminalOptions, terminalTheme } from '../src/terminal-options.js'

const main = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8')

function withScheme(dark, body) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
  globalThis.matchMedia = query => ({ matches: query === '(prefers-color-scheme: dark)' && dark })
  try {
    body()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'matchMedia', previous)
    else delete globalThis.matchMedia
  }
}

test('the cell palette has a value for both schemes', () => {
  // The xterm grid paints its own cells, so terminal.css cannot reach them: a missing key here is a
  // colour that stays on the other scheme's value while everything around it flips.
  assert.deepEqual(Object.keys(terminalTheme(true)), Object.keys(terminalTheme(false)))
  assert.equal(terminalTheme(true).background, '#0b0e14')
  assert.equal(terminalTheme(false).background, '#ffffff')
})

test('a terminal opens on the scheme the system is in', () => {
  withScheme(true, () => {
    assert.equal(prefersDarkScheme(), true)
    assert.equal(terminalOptions().theme.background, '#0b0e14')
  })
  withScheme(false, () => {
    assert.equal(prefersDarkScheme(), false)
    assert.equal(terminalOptions().theme.background, '#ffffff')
  })
})

test('terminals already on screen are re-themed when the scheme flips', () => {
  // terminalOptions() only runs when a terminal is created, so without this listener a running
  // session keeps the palette it booted with until it is torn down.
  assert.match(main, /matchMedia\?\.\('\(prefers-color-scheme: dark\)'\)\.addEventListener\('change'/)
  assert.match(main, /entry\.term\.options\.theme = theme/)
})
