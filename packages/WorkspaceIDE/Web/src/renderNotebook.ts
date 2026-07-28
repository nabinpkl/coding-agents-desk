// DOM rendering for a parsed notebook model (see ipynbModel.mjs). Kept apart
// from viewer.mjs so the dispatcher stays thin and this file owns one concept:
// turning cells into elements. Collaborators (markdown renderer, fenced-code
// highlighter, mermaid pass, escaper) are injected so this module shares the
// viewer's single markdown-it/CodeMirror configuration rather than rebuilding it.
//
// The viewer owns presentation and user intent only. Execution is app-owned:
// Run buttons send a typed message to Swift, and Swift streams run events back.

import { parseNotebook, NotebookParseError } from './ipynbModel.ts'

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

// A code/output payload reuses the markdown fenced-code DOM shape
// (pre.cm-static.cm-pending[data-lang]) so the viewer's existing highlightFenced
// pass styles it in the same sweep — one highlighter, no duplication.
function codeBlock(source, langExt, escapeHtml) {
  const pre = el('pre', 'cm-static cm-pending')
  pre.setAttribute('data-lang', langExt || '')
  pre.innerHTML = `<code>${escapeHtml(source)}</code>`
  return pre
}

function renderOutput(output, deps) {
  const { md, escapeHtml } = deps
  switch (output.kind) {
    case 'stream':
      return el('pre', `nb-out nb-stream nb-stream-${output.name}`, output.text)
    case 'text':
      return el('pre', 'nb-out nb-text', output.text)
    case 'error':
      return el('pre', 'nb-out nb-error', output.text)
    case 'image': {
      const img = el('img', 'nb-out nb-image')
      img.src = output.dataUri
      img.alt = output.mime
      return img
    }
    case 'markdown': {
      const div = el('div', 'nb-out nb-md markdown-body')
      div.innerHTML = md.render(output.text)
      return div
    }
    case 'html-deferred': {
      const wrap = el('div', 'nb-out nb-html-deferred')
      wrap.appendChild(el('div', 'nb-html-note', 'Rich HTML output not shown'))
      if (output.text) wrap.appendChild(el('pre', 'nb-text', output.text))
      return wrap
    }
    default:
      return el('pre', 'nb-out nb-text', escapeHtml(JSON.stringify(output)))
  }
}

function outputFromRunEvent(event) {
  if (event.output) return event.output
  switch (event.type) {
    case 'stream':
      return { kind: 'stream', name: event.name ?? 'stdout', text: event.text ?? '' }
    case 'text':
      return { kind: 'text', text: event.text ?? '' }
    case 'image':
      return { kind: 'image', mime: event.mime ?? 'image/png', dataUri: event.dataUri ?? '' }
    case 'markdown':
      return { kind: 'markdown', text: event.text ?? '' }
    case 'html-deferred':
      return { kind: 'html-deferred', text: event.text ?? '' }
    case 'error':
      return { kind: 'error', text: event.text ?? [event.ename, event.evalue].filter(Boolean).join(': ') }
    default:
      return null
  }
}

// A collapsible region: a left gutter bar + the body, mirroring VS Code's
// per-region collapse. Collapsing clamps the body to a few-line peek (see
// .is-collapsed in CSS) rather than hiding it behind an ellipsis. The gutter
// bar (a <button>, so the surface stays AX-focusable) toggles; clicking the
// clamped peek itself expands it back.
function region(kind, bodyEl, label) {
  const reg = el('div', `nb-region nb-region-${kind}`)

  const bar = el('button', 'nb-gutter-zone')
  bar.setAttribute('aria-label', `Toggle ${label}`)
  bar.setAttribute('title', `Toggle ${label}`)

  const body = el('div', 'nb-region-body')
  body.appendChild(bodyEl)

  bar.addEventListener('click', () => reg.classList.toggle('is-collapsed'))
  body.addEventListener('click', () => {
    if (reg.classList.contains('is-collapsed')) reg.classList.remove('is-collapsed')
  })

  reg.appendChild(bar)
  reg.appendChild(body)
  return reg
}

function renderMarkdownCell(cell, deps) {
  const cellEl = el('section', 'nb-cell nb-cell-markdown')
  cellEl.setAttribute('data-cell-index', String(cell.cellIndex))
  const body = el('div', 'nb-md markdown-body')
  body.innerHTML = deps.md.render(cell.source)
  cellEl.appendChild(region('md', body, 'markdown'))
  return cellEl
}

function renderCodeCell(cell, deps) {
  const cellEl = el('section', 'nb-cell nb-cell-code')
  cellEl.setAttribute('data-cell-index', String(cell.cellIndex))

  const toolbar = el('div', 'nb-cell-toolbar')
  const run = el('button', 'nb-run-button', 'Run')
  run.setAttribute('aria-label', `Run cell ${cell.cellIndex + 1}`)
  run.addEventListener('click', () => deps.send?.({
    type: 'runNotebookCell',
    id: deps.fileID,
    cellIndex: cell.cellIndex,
    source: cell.source,
  }))
  toolbar.appendChild(run)
  toolbar.appendChild(el('span', 'nb-run-status'))
  cellEl.appendChild(toolbar)

  const input = el('div', 'nb-input')
  const count = cell.executionCount == null ? ' ' : cell.executionCount
  input.appendChild(el('div', 'nb-prompt', `In [${count}]:`))
  input.appendChild(codeBlock(cell.source, cell.language?.ext, deps.escapeHtml))
  cellEl.appendChild(region('input', input, 'input'))

  if (cell.outputs.length) cellEl.appendChild(outputRegion(cell.outputs, deps))

  return cellEl
}

function renderRawCell(cell) {
  const cellEl = el('section', 'nb-cell nb-cell-raw')
  cellEl.setAttribute('data-cell-index', String(cell.cellIndex))
  cellEl.appendChild(region('raw', el('pre', 'nb-raw', cell.source), 'raw'))
  return cellEl
}

function outputRegion(outputs, deps) {
  const outputEl = el('div', 'nb-outputs')
  for (const output of outputs) outputEl.appendChild(renderOutput(output, deps))
  return region('output', outputEl, 'output')
}

function renderCell(cell, deps) {
  if (cell.kind === 'markdown') return renderMarkdownCell(cell, deps)
  if (cell.kind === 'code') return renderCodeCell(cell, deps)
  return renderRawCell(cell)
}

/// Render raw .ipynb text into `container`. `deps` supplies the viewer's shared
/// collaborators: { md, escapeHtml, highlightFenced, runMermaid }.
/// A parse failure renders a loud error block rather than a blank surface.
export function renderNotebook(container, text, deps) {
  let model
  try {
    model = parseNotebook(text)
  } catch (error) {
    if (error instanceof NotebookParseError) {
      container.replaceChildren(el('pre', 'nb-out nb-error', `Could not open notebook: ${error.message}`))
      return
    }
    throw error
  }

  const root = el('div', 'nb')
  for (const cell of model.cells) root.appendChild(renderCell(cell, deps))
  container.replaceChildren(root)

  // One highlight + mermaid sweep over the whole notebook: styles code-cell
  // sources and any fenced code inside markdown cells in a single pass.
  deps.highlightFenced(root)
  deps.runMermaid(root)
}

function walk(node, visit) {
  if (visit(node)) return node
  for (const child of node.children ?? []) {
    const found = walk(child, visit)
    if (found) return found
  }
  return null
}

function firstByClass(node, className) {
  return walk(node, (candidate) => candidate.className?.split(/\s+/).includes(className))
}

function cellFor(container, cellIndex) {
  return walk(container, (node) => node.getAttribute?.('data-cell-index') === String(cellIndex))
}

function ensureOutputs(cell, deps) {
  let outputs = firstByClass(cell, 'nb-outputs')
  if (outputs) return outputs
  cell.appendChild(outputRegion([], deps))
  return firstByClass(cell, 'nb-outputs')
}

/// Apply one app-originated notebook execution event to the currently rendered
/// notebook. Unknown or stale cell indexes are ignored because Swift owns the
/// authoritative tab state and may send late events after a re-render.
export function applyNotebookRunEvent(container, event, deps) {
  const cell = cellFor(container, event.cellIndex)
  if (!cell) return

  const status = firstByClass(cell, 'nb-run-status')
  if (event.type === 'started') {
    cell.classList.add('is-running')
    if (status) status.textContent = 'Running'
    ensureOutputs(cell, deps).replaceChildren()
    return
  }

  if (event.type === 'finished') {
    cell.classList.remove('is-running')
    if (status) status.textContent = event.ok === false ? 'Failed' : 'Done'
    if (event.executionCount != null) {
      const prompt = firstByClass(cell, 'nb-prompt')
      if (prompt) prompt.textContent = `In [${event.executionCount}]:`
    }
    return
  }

  const output = outputFromRunEvent(event)
  if (!output) return
  const outputs = ensureOutputs(cell, deps)
  outputs.appendChild(renderOutput(output, deps))
  deps.highlightFenced(outputs)
  deps.runMermaid(outputs)
}
