import { LanguageDescription, LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { justLanguage } from './justLanguage.ts'

// justfiles have no grammar in language-data (none exists for CodeMirror); register our own
// bundled StreamLanguage mode as a descriptor so it resolves through the same path as the rest.
const justDescription = LanguageDescription.of({
  name: 'Just',
  extensions: ['just'],
  filename: /^\.?[Jj]ustfile$/,
  load: async () => new LanguageSupport(justLanguage),
})

const registry = [justDescription, ...languages]

// Resolve a file to a real CodeMirror grammar without a hand-maintained filename allowlist:
// match the registry by filename first, then fall back to *content* (a shebang, then a few
// high-confidence signatures) so the long tail — lockfiles, plist/csproj, extension-less
// scripts — gets its exact grammar. Deliberately conservative: anything ambiguous returns null
// and the caller applies the generic highlight floor (never the wrong language).

// Shebang interpreter -> a language-data language name (matched fuzzily, so aliases also work).
const SHEBANG_LANGS = {
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', dash: 'Shell', ksh: 'Shell', fish: 'Fish',
  python: 'Python', python2: 'Python', python3: 'Python',
  node: 'JavaScript', deno: 'JavaScript', bun: 'JavaScript',
  ruby: 'Ruby', perl: 'Perl', php: 'PHP', lua: 'Lua', r: 'R', tclsh: 'Tcl', groovy: 'Groovy',
}

const byName = (name) => (name ? LanguageDescription.matchLanguageName(registry, name, true) : null)

function shebangLang(text) {
  const firstLine = text.slice(0, 256).split('\n', 1)[0]
  const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine)
  if (!match) return null
  let interpreter = match[1].split('/').pop()
  if (interpreter === 'env' && match[2]) interpreter = match[2].split('/').pop()
  return byName(SHEBANG_LANGS[interpreter.toLowerCase()])
}

function signatureLang(text) {
  const head = text.slice(0, 4096)
  const start = head.trimStart()  // also drops a leading BOM (U+FEFF is whitespace in JS)
  if (/^<(\?xml|!doctype|!--|[a-zA-Z])/i.test(start)) return byName('XML')
  if (/^[{[]/.test(start)) return byName('JSON')
  if (/^\s*\[\[?[^\]\n]+\]\]?\s*$/m.test(head)) return byName('TOML')  // a [section] / [[table]] line
  return null
}

/// `name` + `text` -> the grammar descriptor to load, or null (caller uses the generic floor).
/// Filename match wins (exact, cheapest); then content. Pure — no I/O, no globals.
export function detectLanguage(name, text) {
  const byFile = LanguageDescription.matchFilename(registry, name)
  if (byFile) return byFile
  if (!text) return null
  return shebangLang(text) ?? signatureLang(text) ?? null
}
