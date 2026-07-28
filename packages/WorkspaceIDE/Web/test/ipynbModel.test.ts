import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseNotebook, stripAnsi, NotebookParseError } from '../src/ipynbModel.ts'

// ANSI escape char as a hex escape, so the source file stays pure ASCII.
const ESC = '\x1b'

const nb = (overrides) => JSON.stringify({
  nbformat: 4,
  metadata: { language_info: { name: 'python', file_extension: '.py' } },
  cells: [],
  ...overrides,
})

test('parses markdown and code cells with joined array source', () => {
  const model = parseNotebook(nb({
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'body'] },
      { cell_type: 'code', source: 'print(1)', execution_count: 3, outputs: [] },
    ],
  }))
  assert.equal(model.cells.length, 2)
  assert.deepEqual(model.cells[0], { kind: 'markdown', cellIndex: 0, source: '# Title\nbody' })
  assert.equal(model.cells[1].kind, 'code')
  assert.equal(model.cells[1].cellIndex, 1)
  assert.equal(model.cells[1].source, 'print(1)')
  assert.equal(model.cells[1].executionCount, 3)
})

test('preserves original cell indexes for run targets', () => {
  const model = parseNotebook(nb({
    cells: [
      { cell_type: 'markdown', source: 'intro' },
      { cell_type: 'code', source: 'a = 1', outputs: [] },
      { cell_type: 'code', source: 'a', outputs: [] },
    ],
  }))
  assert.deepEqual(model.cells.map((cell) => cell.cellIndex), [0, 1, 2])
})

test('reads language ext from metadata for highlighting', () => {
  const model = parseNotebook(nb({ cells: [{ cell_type: 'code', source: 'x' }] }))
  assert.deepEqual(model.language, { name: 'python', ext: 'py' })
  assert.equal(model.cells[0].language.ext, 'py')
})

test('falls back to language-name extension table when file_extension is absent', () => {
  const model = parseNotebook(nb({ metadata: { language_info: { name: 'Ruby' } } }))
  assert.equal(model.language.ext, 'rb')
})

test('normalizes stream output', () => {
  const model = parseNotebook(nb({
    cells: [{ cell_type: 'code', source: '', outputs: [
      { output_type: 'stream', name: 'stdout', text: ['line1\n', 'line2'] },
    ] }],
  }))
  assert.deepEqual(model.cells[0].outputs[0], { kind: 'stream', name: 'stdout', text: 'line1\nline2' })
})

test('normalizes image output to a data URI', () => {
  const model = parseNotebook(nb({
    cells: [{ cell_type: 'code', source: '', outputs: [
      { output_type: 'display_data', data: { 'image/png': 'AAAB\nCCCD\n' } },
    ] }],
  }))
  assert.deepEqual(model.cells[0].outputs[0], {
    kind: 'image', mime: 'image/png', dataUri: 'data:image/png;base64,AAABCCCD',
  })
})

test('execute_result prefers text/plain over text/html', () => {
  const model = parseNotebook(nb({
    cells: [{ cell_type: 'code', source: '', outputs: [
      { output_type: 'execute_result', data: { 'text/plain': '42', 'text/html': '<b>42</b>' } },
    ] }],
  }))
  assert.deepEqual(model.cells[0].outputs[0], { kind: 'text', text: '42' })
})

test('html-only output is deferred, not rendered as live HTML', () => {
  const model = parseNotebook(nb({
    cells: [{ cell_type: 'code', source: '', outputs: [
      { output_type: 'display_data', data: { 'text/html': '<table></table>' } },
    ] }],
  }))
  assert.equal(model.cells[0].outputs[0].kind, 'html-deferred')
})

test('error traceback is joined and ANSI-stripped', () => {
  const colored = `${ESC}[0;31mZeroDivisionError${ESC}[0m: division by zero`
  const model = parseNotebook(nb({
    cells: [{ cell_type: 'code', source: '', outputs: [
      { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero',
        traceback: ['Traceback...', colored] },
    ] }],
  }))
  const out = model.cells[0].outputs[0]
  assert.equal(out.kind, 'error')
  assert.equal(out.text, 'Traceback...\nZeroDivisionError: division by zero')
})

test('stripAnsi removes SGR color codes', () => {
  assert.equal(stripAnsi(`${ESC}[1;32mok${ESC}[0m`), 'ok')
  assert.equal(stripAnsi('no codes here'), 'no codes here')
})

test('flattens nbformat 3 worksheets', () => {
  const model = parseNotebook(JSON.stringify({
    nbformat: 3,
    worksheets: [{ cells: [{ cell_type: 'markdown', source: 'hi' }] }],
  }))
  assert.equal(model.cells.length, 1)
  assert.equal(model.cells[0].source, 'hi')
})

test('throws on invalid JSON', () => {
  assert.throws(() => parseNotebook('{not json'), NotebookParseError)
})

test('throws when there is no cell list', () => {
  assert.throws(() => parseNotebook(JSON.stringify({ nbformat: 4 })), NotebookParseError)
})
