import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Minimal DOM stub: renderNotebook only needs createElement + the handful of
// node operations below, and its heavy collaborators (markdown-it, the
// highlighter, mermaid) are injected — so structure is testable under
// `node --test` without a browser or jsdom.
class StubEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.className = ''
    this.children = []
    this.attributes = {}
    this.textContent = ''
    this.innerHTML = ''
    this._listeners = {}
    const cls = () => (this.className ? this.className.split(/\s+/) : [])
    this.classList = {
      contains: (c) => cls().includes(c),
      add: (c) => { const s = new Set(cls()); s.add(c); this.className = [...s].join(' ') },
      remove: (c) => { const s = new Set(cls()); s.delete(c); this.className = [...s].join(' ') },
      toggle: (c) => {
        if (cls().includes(c)) this.classList.remove(c)
        else this.classList.add(c)
        return this.classList.contains(c)
      },
    }
  }
  setAttribute(k, v) { this.attributes[k] = v }
  getAttribute(k) { return this.attributes[k] ?? null }
  appendChild(c) { this.children.push(c); return c }
  replaceChildren(...kids) { this.children = kids }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn) }
  click() { for (const fn of this._listeners.click ?? []) fn() }
}

globalThis.document = { createElement: (tag) => new StubEl(tag) }

const { applyNotebookRunEvent, renderNotebook } = await import('../src/renderNotebook.ts')

const sent = []
const deps = {
  md: { render: (t) => `<rendered>${t}</rendered>` },
  escapeHtml: (s) => s,
  highlightFenced: () => {},
  runMermaid: () => {},
  send: (message) => sent.push(message),
  fileID: '/tmp/sample.ipynb',
}

// Walk the stub tree collecting every node whose className contains `token`.
function findAll(node, token, acc = []) {
  if (node.className && node.className.split(/\s+/).includes(token)) acc.push(node)
  for (const child of node.children) findAll(child, token, acc)
  return acc
}

const render = (text) => {
  sent.length = 0
  const container = new StubEl('main')
  renderNotebook(container, text, deps)
  return container
}

const sample = readFileSync(fileURLToPath(new URL('./sample.ipynb', import.meta.url)), 'utf8')

test('renders one section per cell from the sample notebook', () => {
  const container = render(sample)
  const root = container.children[0]
  assert.equal(root.className, 'nb')
  assert.equal(root.children.length, 4) // 1 markdown + 3 code
})

test('markdown cell goes through the injected markdown renderer', () => {
  const container = render(sample)
  const md = findAll(container, 'nb-cell-markdown')
  assert.equal(md.length, 1)
  const body = findAll(md[0], 'nb-md')[0]
  assert.match(body.innerHTML, /<rendered># Sample notebook/)
})

test('code cell emits a highlightable pre with the language extension', () => {
  const container = render(sample)
  const pres = findAll(container, 'cm-static')
  assert.ok(pres.length >= 3) // one per code cell
  assert.equal(pres[0].getAttribute('data-lang'), 'py')
  assert.match(pres[0].innerHTML, /print\('hello'\)/)
})

test('execution count shows in the prompt', () => {
  const container = render(sample)
  const prompts = findAll(container, 'nb-prompt')
  assert.deepEqual(prompts.map((p) => p.textContent), ['In [1]:', 'In [2]:', 'In [3]:'])
})

test('code cells expose run buttons that send cell index and source', () => {
  const container = render(sample)
  const buttons = findAll(container, 'nb-run-button')
  assert.equal(buttons.length, 3)

  buttons[1].click()
  assert.deepEqual(sent[0], {
    type: 'runNotebookCell',
    id: '/tmp/sample.ipynb',
    cellIndex: 2,
    source: 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])',
  })
})

test('stream / image / error outputs each render to their own node', () => {
  const container = render(sample)
  const stream = findAll(container, 'nb-stream')
  assert.equal(stream[0].textContent, 'hello\nworld\n')

  const img = findAll(container, 'nb-image')
  assert.equal(img.length, 1)
  assert.ok(img[0].src.startsWith('data:image/png;base64,'))

  const err = findAll(container, 'nb-error')
  assert.equal(err.length, 1)
  assert.ok(err[0].textContent.includes('ZeroDivisionError: division by zero'))
  assert.ok(!err[0].textContent.includes('\x1b')) // ANSI stripped
})

test('a parse failure renders a loud error block, not a blank surface', () => {
  const container = render('{ not valid json')
  const errs = findAll(container, 'nb-error')
  assert.equal(errs.length, 1)
  assert.match(errs[0].textContent, /Could not open notebook/)
})

const gutterOf = (region) => region.children.find((c) => c.className.includes('nb-gutter-zone'))

const bodyOf = (region) => region.children.find((c) => c.className.includes('nb-region-body'))

test('clicking a region gutter bar toggles its collapsed peek', () => {
  const container = render(sample)
  const inputRegion = findAll(container, 'nb-region-input')[0]
  assert.equal(inputRegion.classList.contains('is-collapsed'), false)

  gutterOf(inputRegion).click()
  assert.equal(inputRegion.classList.contains('is-collapsed'), true)

  gutterOf(inputRegion).click()
  assert.equal(inputRegion.classList.contains('is-collapsed'), false)
})

test('clicking the clamped peek body expands it (but does not re-collapse)', () => {
  const container = render(sample)
  const inputRegion = findAll(container, 'nb-region-input')[0]
  const body = bodyOf(inputRegion)

  gutterOf(inputRegion).click() // collapse to peek
  assert.equal(inputRegion.classList.contains('is-collapsed'), true)

  body.click() // clicking the peek expands
  assert.equal(inputRegion.classList.contains('is-collapsed'), false)

  body.click() // clicking expanded body must NOT collapse it
  assert.equal(inputRegion.classList.contains('is-collapsed'), false)
})

test('input and output collapse independently (VS Code split-bar behavior)', () => {
  const container = render(sample)
  const cellWithOutput = findAll(container, 'nb-cell-code')
    .find((c) => findAll(c, 'nb-region-output').length > 0)
  assert.ok(cellWithOutput)

  const inputRegion = findAll(cellWithOutput, 'nb-region-input')[0]
  const outputRegion = findAll(cellWithOutput, 'nb-region-output')[0]

  gutterOf(outputRegion).click()
  assert.equal(outputRegion.classList.contains('is-collapsed'), true)
  assert.equal(inputRegion.classList.contains('is-collapsed'), false)
})

test('run events clear, append, and finish outputs for a cell', () => {
  const container = render(sample)
  applyNotebookRunEvent(container, { type: 'started', cellIndex: 1 }, deps)

  const firstCell = findAll(container, 'nb-cell-code')[0]
  assert.equal(firstCell.classList.contains('is-running'), true)
  assert.equal(findAll(firstCell, 'nb-stream').length, 0)
  assert.equal(findAll(firstCell, 'nb-run-status')[0].textContent, 'Running')

  applyNotebookRunEvent(container, { type: 'stream', cellIndex: 1, name: 'stdout', text: 'new\n' }, deps)
  assert.equal(findAll(firstCell, 'nb-stream')[0].textContent, 'new\n')

  applyNotebookRunEvent(container, { type: 'finished', cellIndex: 1, executionCount: 4 }, deps)
  assert.equal(firstCell.classList.contains('is-running'), false)
  assert.equal(findAll(firstCell, 'nb-run-status')[0].textContent, 'Done')
  assert.equal(findAll(firstCell, 'nb-prompt')[0].textContent, 'In [4]:')
})

test('run error event appends a visible error block', () => {
  const container = render(sample)
  applyNotebookRunEvent(container, { type: 'started', cellIndex: 1 }, deps)
  applyNotebookRunEvent(container, { type: 'error', cellIndex: 1, text: 'ValueError: bad' }, deps)

  const firstCell = findAll(container, 'nb-cell-code')[0]
  const errors = findAll(firstCell, 'nb-error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].textContent, 'ValueError: bad')
})

test('markdown output keeps prose typography instead of inheriting monospace output chrome', () => {
  const container = render(sample)
  applyNotebookRunEvent(container, { type: 'markdown', cellIndex: 1, text: '# Result' }, deps)

  const firstCell = findAll(container, 'nb-cell-code')[0]
  const markdown = findAll(firstCell, 'nb-md')
  assert.equal(markdown.length, 1)
  assert.ok(markdown[0].className.split(/\s+/).includes('prose'))
  assert.ok(!markdown[0].className.split(/\s+/).includes('nb-out'))
})
