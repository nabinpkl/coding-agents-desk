// Pure ipynb parser: raw .ipynb JSON text -> a normalized notebook model the
// renderer can walk without knowing nbformat quirks. No DOM, no I/O, no globals,
// so it unit-tests under `node --test` like detectLanguage.mjs.
//
// We target nbformat 4 (the modern standard: top-level `cells`), and tolerate
// the nbformat 3 shape (`worksheets[].cells`) by flattening it. Anything we
// cannot parse throws — a notebook that does not parse is an error to surface,
// not an empty render to paper over.

export class NotebookParseError extends Error {}

// Strip ANSI escape sequences (kernels colorize tracebacks). Matches both the
// 7-bit ESC[ ... and 8-bit CSI forms through their final byte. \x1b/\x9b keep
// the control bytes out of the source as plain ASCII escapes.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x9b[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (s) => s.replace(ANSI, '')

// nbformat stores multiline payloads as either a string or an array of line
// fragments (each usually newline-terminated). Normalize to one string.
const joinSource = (src) => (Array.isArray(src) ? src.join('') : (src ?? ''))

const EXT_BY_LANGUAGE = {
  python: 'py', r: 'r', julia: 'jl', ruby: 'rb', javascript: 'js',
  typescript: 'ts', scala: 'scala', bash: 'sh', sh: 'sh', sql: 'sql',
  rust: 'rs', go: 'go', haskell: 'hs', c: 'c', 'c++': 'cpp', cpp: 'cpp',
}

// Pick the language for code-cell highlighting from notebook metadata. Returns
// { name, ext } where ext is an extension hint detectLanguage can resolve
// (e.g. "py"). Empty ext => caller applies the generic highlight floor.
function readLanguage(nb) {
  const info = nb?.metadata?.language_info ?? {}
  const name = info.name ?? nb?.metadata?.kernelspec?.language ?? ''
  let ext = (info.file_extension ?? '').replace(/^\./, '')
  if (!ext && name) ext = EXT_BY_LANGUAGE[name.toLowerCase()] ?? ''
  return { name, ext }
}

const MIME_PRECEDENCE = [
  'image/png', 'image/jpeg', 'image/gif',
  'text/markdown', 'text/plain', 'text/html',
]

// One MIME bundle (execute_result / display_data) -> one normalized output.
// Rich text/html is deliberately NOT rendered as live HTML in v0 (XSS surface +
// blocked by the viewer CSP); we prefer text/plain and fall back to a flagged
// placeholder. Tracked as a follow-up, not silently dropped.
function normalizeMimeBundle(data) {
  for (const mime of MIME_PRECEDENCE) {
    if (!(mime in data)) continue
    const raw = data[mime]
    if (mime.startsWith('image/')) {
      // base64 payloads arrive as a string (sometimes line-wrapped array).
      const base64 = (Array.isArray(raw) ? raw.join('') : raw).replace(/\s+/g, '')
      return { kind: 'image', mime, dataUri: `data:${mime};base64,${base64}` }
    }
    if (mime === 'text/markdown') return { kind: 'markdown', text: joinSource(raw) }
    if (mime === 'text/plain') return { kind: 'text', text: joinSource(raw) }
    if (mime === 'text/html') {
      const plain = 'text/plain' in data ? joinSource(data['text/plain']) : ''
      return { kind: 'html-deferred', text: plain }
    }
  }
  return null
}

function normalizeOutput(out) {
  switch (out.output_type) {
    case 'stream':
      return { kind: 'stream', name: out.name ?? 'stdout', text: joinSource(out.text) }
    case 'execute_result':
    case 'display_data':
      return normalizeMimeBundle(out.data ?? {})
    case 'error':
      return {
        kind: 'error',
        ename: out.ename ?? '',
        evalue: out.evalue ?? '',
        text: stripAnsi((out.traceback ?? []).join('\n')),
      }
    default:
      return null
  }
}

function normalizeCell(cell, language, cellIndex) {
  const type = cell.cell_type
  if (type === 'markdown') {
    return { kind: 'markdown', cellIndex, source: joinSource(cell.source) }
  }
  if (type === 'code') {
    return {
      kind: 'code',
      cellIndex,
      source: joinSource(cell.source),
      executionCount: cell.execution_count ?? null,
      language,
      outputs: (cell.outputs ?? []).map(normalizeOutput).filter(Boolean),
    }
  }
  // raw cells and unknown types render as plain preformatted source.
  return { kind: 'raw', cellIndex, source: joinSource(cell.source) }
}

/// Parse raw .ipynb text into { language: {name, ext}, cells: [...] }.
/// Throws NotebookParseError on invalid JSON or a missing cell list.
export function parseNotebook(text) {
  let nb
  try {
    nb = JSON.parse(text)
  } catch (error) {
    throw new NotebookParseError(`invalid notebook JSON: ${error.message}`)
  }

  const rawCells = Array.isArray(nb.cells)
    ? nb.cells
    : Array.isArray(nb.worksheets)
      ? nb.worksheets.flatMap((w) => w.cells ?? [])
      : null
  if (!rawCells) throw new NotebookParseError('notebook has no cells')

  const language = readLanguage(nb)
  return { language, cells: rawCells.map((c, index) => normalizeCell(c, language, index)) }
}
