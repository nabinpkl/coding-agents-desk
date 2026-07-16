import { StreamLanguage } from '@codemirror/language'

// A language-agnostic highlight floor: when no real grammar matches a file, this still colors
// the cross-language subset — comments, strings, numbers, and a few universal keywords — so
// every text file (justfile, an odd config, anything) reads as code, not flat text. It never
// picks a language, so it is never "wrong language"; it just trades exactness for coverage.
//
// Comment leaders are the two least-ambiguous ones (`#` and `//`) plus `/* */`; `;`/`--` are
// deliberately excluded because they double as statement terminators / operators and would
// comment out half a line. Strings are single-line (a multi-line string colors per line). The
// styles returned (comment/string/number/keyword) map to the standard tags oneDark colors.

const KEYWORDS = new Set([
  'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
  'function', 'func', 'fn', 'def', 'class', 'struct', 'enum', 'interface', 'trait', 'impl',
  'import', 'export', 'from', 'use', 'include', 'require', 'module', 'package', 'namespace',
  'const', 'let', 'var', 'val', 'static', 'public', 'private', 'protected', 'final',
  'true', 'false', 'null', 'nil', 'none', 'void', 'new', 'this', 'self', 'super',
])

export const genericLanguage = StreamLanguage.define({
  name: 'generic',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) { stream.match('*/'); state.inBlockComment = false }
      else stream.skipToEnd()
      return 'comment'
    }
    if (stream.eatSpace()) return null

    if (stream.match('/*')) {
      if (stream.skipTo('*/')) stream.match('*/')
      else { stream.skipToEnd(); state.inBlockComment = true }
      return 'comment'
    }
    if (stream.match('//') || stream.match('#')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/) ||
        stream.match(/^`(?:[^`\\]|\\.)*`?/)) {
      return 'string'
    }
    if (stream.match(/^0x[0-9a-fA-F]+/) || stream.match(/^\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?/)) {
      return 'number'
    }
    const word = stream.match(/^[A-Za-z_]\w*/)
    if (word) return KEYWORDS.has(word[0]) ? 'keyword' : null

    stream.next()
    return null
  },
})
