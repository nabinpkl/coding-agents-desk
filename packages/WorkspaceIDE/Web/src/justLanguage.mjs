import { StreamLanguage } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// A small CodeMirror StreamLanguage for justfiles (casey/just). No Lezer/TextMate/tree-sitter
// grammar exists for CodeMirror 6, and just's syntax is regular enough to tokenize directly:
// `#` comments, `name := "value"` assignments, `recipe args: deps` headers, `set`/`export`/
// `alias`/`import`/`mod` settings, `{{ … }}` interpolations, and string literals. Recipe bodies
// (indented lines) are shell and left mostly plain, matching how editors render them.
//
// Each line is classified once at its start (assignment vs recipe vs setting vs body), so the
// leading identifier gets the right color; the rest of the line uses the shared token rules.

const KEYWORD_LINE = /^\s*(set|export|alias|import|mod)\b/
const ASSIGNMENT = /^\s*@?[A-Za-z_][\w-]*\s*:=/
const RECIPE_HEADER = /^@?[A-Za-z_][\w-]*[^:]*:(?!=)/  // name [args]: — a single colon, not :=
const IDENT = /^@?[A-Za-z_][\w-]*/

function eatString(stream, quote) {
  let escaped = false
  let ch
  while ((ch = stream.next()) != null) {
    if (ch === quote && !escaped) break
    escaped = !escaped && ch === '\\'
  }
}

export const justLanguage = StreamLanguage.define({
  name: 'just',
  startState: () => ({ lineType: 'plain', firstIdent: true }),
  token(stream, state) {
    if (stream.sol()) {
      const line = stream.string
      if (/^\s/.test(line)) state.lineType = 'body'            // indented -> recipe body (shell)
      else if (ASSIGNMENT.test(line)) state.lineType = 'assign'
      else if (RECIPE_HEADER.test(line)) state.lineType = 'recipe'
      else if (KEYWORD_LINE.test(line)) state.lineType = 'keywordLine'
      else state.lineType = 'plain'
      state.firstIdent = true
    }

    if (stream.eatSpace()) return null

    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment' }

    const ch = stream.peek()
    if (ch === '"' || ch === "'" || ch === '`') { stream.next(); eatString(stream, ch); return 'string' }

    if (stream.match('{{') || stream.match('}}')) return 'interp'

    // The first identifier on a non-body line is the assignment / recipe / setting name.
    if (state.firstIdent && state.lineType !== 'body' && state.lineType !== 'plain' && /[A-Za-z_@]/.test(ch)) {
      state.firstIdent = false
      if (stream.match(IDENT)) {
        if (state.lineType === 'assign') return 'assignName'
        if (state.lineType === 'recipe') return 'recipeName'
        if (state.lineType === 'keywordLine') return 'keyword'
      }
    }

    if (stream.match(/^\d[\d_]*\.?\d*/)) return 'number'
    if (stream.match(':=') || stream.match(/^[:=&|*+]/)) return 'operator'
    if (stream.match(IDENT)) return null

    stream.next()
    return null
  },
  tokenTable: {
    comment: t.comment,
    string: t.string,
    number: t.number,
    keyword: t.keyword,
    operator: t.operator,
    assignName: t.name,                       // assignment LHS — coral in oneDark
    recipeName: t.function(t.variableName),   // recipe header — blue in oneDark
    interp: t.meta,
  },
})
