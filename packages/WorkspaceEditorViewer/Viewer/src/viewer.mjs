// Per-tab editor surface. Swift owns tabs, preview windows, conflict UI, and save debounce.
// This web surface only renders one file payload at a time and reports edits back to Swift.

import MarkdownIt from 'markdown-it'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import { EditorView, lineNumbers, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightCode, classHighlighter, tags } from '@lezer/highlight'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { detectLanguage } from './detectLanguage.mjs'
import { genericLanguage } from './genericLanguage.mjs'
import { applyNotebookRunEvent, renderNotebook } from './renderNotebook.mjs'
import { renderDocx } from './renderDocx.mjs'
import {
  captureDocumentViewport,
  documentZoomFor,
  restoreDocumentViewport,
} from './documentViewportState.mjs'
import { ViewerZoomController } from './viewerZoom.mjs'

const content = document.getElementById('content')
const language = new Compartment()
const editorTheme = new Compartment()
const send = (message) => window.webkit?.messageHandlers?.shell?.postMessage(message)
const themeMedia = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null

const editorHighlight = Prec.highest(syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--tok-string)' },
  { tag: tags.keyword, color: 'var(--tok-keyword)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--tok-number)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--tok-type)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--tok-name)' },
  { tag: [tags.function(tags.variableName), tags.operator, tags.derefOperator], color: 'var(--tok-function)' },
  { tag: [tags.meta, tags.punctuation, tags.bracket], color: 'var(--fg-dim)' },
])))

const escapeHtml = (s) => s.replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
))

let active = null
const documentViewports = new Map()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, lang) {
    if (lang === 'mermaid') return `<div class="mermaid-pending">${escapeHtml(code)}</div>`
    return `<pre class="cm-static cm-pending" data-lang="${escapeHtml(lang || '')}"><code>${escapeHtml(code)}</code></pre>`
  },
})

function destroyActiveView() {
  captureDocumentViewport(documentViewports, active)
  active?.abortController?.abort()
  active?.viewport?.destroy()
  active?.view?.destroy()
}

async function render(payload) {
  destroyActiveView()
  active = {
    id: payload.id,
    name: payload.name,
    text: payload.text ?? '',
    kind: payload.kind ?? 'text',
    mode: payload.mode ?? 'preview',
    resourceURL: payload.resourceURL ?? null,
    view: null,
    viewport: null,
    scroller: null,
    abortController: null,
  }
  const state = active

  if (active.kind === 'notebook') {
    renderNotebook(content, active.text, { md, escapeHtml, highlightFenced, runMermaid, send, fileID: active.id })
    return
  }

  if (active.kind === 'docx') {
    const abortController = new AbortController()
    active.abortController = abortController
    try {
      const viewport = await renderDocx(content, active.resourceURL, {
        initialZoom: documentZoomFor(documentViewports, active.id),
        signal: abortController.signal,
      })
      if (active !== state) {
        viewport.destroy()
        return
      }
      active.viewport = viewport
      active.scroller = viewport.scroller
      restoreDocumentViewport(documentViewports, active)
    } catch (error) {
      if (error?.name === 'AbortError' || active !== state) return
      renderFailure(`Could not open ${active.name}`, error)
    }
    return
  }

  if (active.kind === 'markdown' && active.mode === 'preview') {
    renderMarkdown(active)
    return
  }

  renderEditor(active)
}

function renderFailure(title, error) {
  const failure = document.createElement('div')
  failure.className = 'viewer-error'
  const heading = document.createElement('strong')
  heading.textContent = title
  const detail = document.createElement('span')
  detail.textContent = error?.message ?? String(error)
  failure.append(heading, detail)
  content.replaceChildren(failure)
}

function applyRunEvent(event) {
  if (active?.kind !== 'notebook') return
  applyNotebookRunEvent(content, event, { md, escapeHtml, highlightFenced, runMermaid })
}

const zoomController = new ViewerZoomController({
  applyTextZoom(zoom) {
    const root = document.documentElement
    root.style.setProperty('--editor-code-font-size', `${zoom.editorCodePointSize}px`)
    root.style.setProperty('--markdown-font-size', `${zoom.markdownPointSize}px`)
    active?.view?.requestMeasure()
  },
})

function setTextZoom(zoom) {
  zoomController.setTextZoom(zoom)
}

function zoomIn() {
  zoomController.zoomIn(active)
}

function zoomOut() {
  zoomController.zoomOut(active)
}

function renderMarkdown(state) {
  const article = document.createElement('article')
  article.className = 'markdown-body'
  article.innerHTML = md.render(state.text)
  content.replaceChildren(article)
  runMermaid(article)
  highlightFenced(article)
}

function renderEditor(state) {
  const editable = state.mode === 'edit'
  const extensions = [
    lineNumbers(),
    editorTheme.of(editorThemeExtensions()),
    EditorView.lineWrapping,
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.editable.of(editable),
    EditorState.readOnly.of(!editable),
    language.of([]),
  ]

  if (editable) {
    extensions.push(EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        state.text = update.state.doc.toString()
        send({ type: 'dirty', id: state.id, text: state.text })
      }
    }))
  }

  const view = new EditorView({ doc: state.text, extensions })

  state.view = view
  content.replaceChildren(view.dom)
  loadGrammarInto(state, view)
  if (editable) view.focus()
}

function editorThemeExtensions() {
  return [
    EditorView.theme({
      '&': {
        backgroundColor: 'var(--bg)',
        color: 'var(--fg)',
      },
      '.cm-content': {
        caretColor: 'var(--accent)',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: 'var(--accent)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--editor-selection)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg)',
        color: 'var(--fg-dim)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: 'var(--editor-active-line)',
      },
    }, { dark: isDarkSystemTheme() }),
    editorHighlight,
  ]
}

function isDarkSystemTheme() {
  return themeMedia?.matches ?? false
}

function refreshEditorTheme() {
  active?.view?.dispatch({ effects: editorTheme.reconfigure(editorThemeExtensions()) })
}

async function loadGrammarInto(state, view) {
  const desc = detectLanguage(state.name, state.text)
  if (!desc) {
    view.dispatch({ effects: language.reconfigure(genericLanguage) })
    return
  }

  let support
  try {
    support = await desc.load()
  } catch (error) {
    console.error(`grammar load failed for ${state.name}:`, error)
    view.dispatch({ effects: language.reconfigure(genericLanguage) })
    return
  }

  if (active?.view !== view) return
  view.dispatch({ effects: language.reconfigure(support) })
}

async function runMermaid(container) {
  const blocks = container.querySelectorAll('.mermaid-pending')
  if (!blocks.length) return
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, theme: mermaidTheme() })

  let n = 0
  for (const block of blocks) {
    if (!block.isConnected) continue
    const el = document.createElement('div')
    el.className = 'mermaid-rendered'
    try {
      const { svg } = await mermaid.render(`mermaid-${n++}-${block.textContent.length}`, block.textContent)
      el.innerHTML = svg
    } catch (error) {
      el.className = 'mermaid-error'
      el.textContent = `Mermaid error: ${error?.message ?? error}`
    }
    if (!block.isConnected) continue
    block.replaceWith(el)
  }
}

function mermaidTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'
}

async function highlightFenced(container) {
  for (const block of container.querySelectorAll('pre.cm-pending')) {
    if (!block.isConnected) continue
    block.classList.remove('cm-pending')
    const desc = detectLanguage(`fence.${block.getAttribute('data-lang') || 'txt'}`, block.textContent)
    if (!desc) continue

    let support
    try {
      support = await desc.load()
    } catch (error) {
      console.error('fenced-code grammar load failed:', error)
      continue
    }

    const code = block.textContent
    let out = ''
    highlightCode(code, support.language.parser.parse(code), classHighlighter,
      (text, classes) => { out += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text) },
      () => { out += '\n' })
    if (!block.isConnected) continue
    block.innerHTML = `<code>${out}</code>`
  }
}

if (themeMedia?.addEventListener) {
  themeMedia.addEventListener('change', refreshEditorTheme)
} else if (themeMedia?.addListener) {
  themeMedia.addListener(refreshEditorTheme)
}

window.fileSurface = {
  render,
  setTextZoom,
  zoomIn,
  zoomOut,
  applyNotebookRunEvent: applyRunEvent,
}

send({ type: 'ready' })
