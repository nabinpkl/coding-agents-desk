// The editable code surface.
//
// A textarea over a highlighted `<pre>`, beside a `<pre>` of line numbers, all three in the same
// monospace metrics and scrolled together. The textarea is transparent apart from its caret and
// selection, so what the reader sees is the highlighted layer and what they type into is a plain
// form control.
//
// CodeMirror was the plan and is not here, because `bun add` cannot reach the npm registry from
// this machine: every attempt fails TLS verification on a different package (`bun add` resolves
// some manifests and rejects others on each run, while `npm view` against the same registry
// succeeds). Working around that means disabling certificate verification or adding a second
// lockfile, and both are worse than this. `docs/TASKS.md` carries the swap; it is one file.
//
// What this costs against CodeMirror, so nobody discovers it as a surprise: no bracket matching,
// no multiple cursors, no folding, and no virtualisation, so a very large file lays out all of its
// lines. What it keeps: highlighting, the browser's own undo, find, spellcheck-off, and a caret
// that behaves the way every other text field on the machine does.
//
// Source does not wrap here, and that is what the gutter is built on. A numbered line has to be
// ONE row for its number to sit beside it, and a soft-wrapped line is however many rows the pane
// is narrow enough to make it -- so a gutter over wrapped text drifts further from the code with
// every long line. It is also the panel's standing answer for source either way: `markdown.css`
// scrolls code blocks rather than wrapping them because source is read by its indentation, and
// `CommitDiff` scrolls its patch for the same reason.

import { useMemo, useRef } from "react";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { SHIKI_THEMES, useCodeHighlighting } from "@/features/activity-feed/markdown/highlighter";
// The colours the painted layer wears. Imported here rather than relied on from a neighbour,
// because the rule that reads Shiki's per-token variables is what makes this surface coloured at
// all, and an editor that depends on a stylesheet nothing here mentions is one import away from
// silently going grey again.
import "@/features/activity-feed/markdown/markdown.css";

/** Shared metrics, so the three layers agree character for character. */
const LAYER = "m-0 py-3 font-mono text-[13px] leading-[1.55] whitespace-pre";

/** What the two code layers hold, once the gutter has taken the left edge. */
const CODE = "pl-2 pr-3";

/**
 * Shiki hands back its own `<pre class="shiki">`, which lands INSIDE the layer above.
 *
 * Left alone it keeps its own background and font, and it is the element the horizontal scroll has
 * to happen on, so these push the outer layer's metrics onto it and let it grow past the box.
 */
const PAINTED =
  "[&_.shiki]:m-0 [&_.shiki]:bg-transparent [&_.shiki]:whitespace-pre" +
  " [&_.shiki]:font-[inherit] [&_.shiki]:text-[length:inherit] [&_.shiki]:leading-[inherit]" +
  // As wide as its longest line rather than as wide as the box, so the layer it sits in has
  // something to scroll. Left at the box's width its lines would overflow a child that is already
  // the full width, and the outer layer would have no horizontal range to follow the textarea's.
  " [&_.shiki]:w-max [&_.shiki]:overflow-visible";

/** A line to bring into view and mark: `[start, end)` are character offsets into that line. */
export interface LineReveal {
  line: number;
  start: number;
  end: number;
  nonce: number;
}

/**
 * Where a textarea would put a line: the offset of its first character, and its top in pixels.
 * Measured from the control's own computed metrics rather than restated here, so a change to
 * `LAYER` cannot leave the band a line off.
 */
function lineGeometry(control: HTMLTextAreaElement, text: string, line: number) {
  const lines = text.split("\n");
  const index = Math.min(Math.max(line, 1), lines.length) - 1;
  let offset = 0;
  for (let at = 0; at < index; at += 1) offset += lines[at]!.length + 1;
  const style = getComputedStyle(control);
  const height = Number.parseFloat(style.lineHeight) || 20;
  const top = (Number.parseFloat(style.paddingTop) || 0) + index * height;
  return { offset, lineLength: lines[index]!.length, top, height };
}

export function CodeEditor({
  path,
  text,
  onChange,
  reveal,
}: {
  path: string;
  text: string;
  /** Absent for a file that is only read: the same surface, with the caret but no typing. */
  onChange?: (text: string) => void;
  /** A line to scroll to and mark, from a search result or a `file:line` in quick open. */
  reveal?: LineReveal;
}) {
  const readOnly = onChange === undefined;
  // The path, not an extension pulled off it: the highlighter takes a file name as readily as a
  // fence language, which is what gives `Justfile` and `Dockerfile` a grammar at all.
  const { highlighter, lang } = useCodeHighlighting(path);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const painted = useRef<HTMLPreElement | null>(null);
  const gutter = useRef<HTMLPreElement | null>(null);
  // The band behind a revealed line, and where it sits in the content. Moved by the same scroll
  // sync as the layers, so it stays on its line as the reader scrolls away and back.
  const band = useRef<HTMLDivElement | null>(null);
  const bandTop = useRef<number | null>(null);
  const applied = useRef<number | null>(null);

  const html = useMemo(() => {
    if (!highlighter) return null;
    // A trailing newline so the last line has a row to sit on and the two layers stay the same
    // height; without it the highlighted layer is one line short and the caret hangs off it.
    return highlighter.codeToHtml(`${text}\n`, {
      lang,
      themes: SHIKI_THEMES,
      defaultColor: false,
    });
  }, [highlighter, lang, text]);

  // As many numbers as the textarea has lines, which is one fewer than the painted layer's spare
  // row. Rebuilt only when the COUNT moves rather than on every keystroke: a ten-thousand-line
  // file is a 50KB string, and typing inside a line does not change a single digit of it.
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const numbers = useMemo(
    // The trailing newline is the gutter's own spare row, and it earns its place: the textarea
    // carries a horizontal scrollbar that the gutter does not, so without it the textarea can
    // scroll about a line further than the gutter can follow and the numbers part from the code
    // at the very bottom of a long file.
    () => `${Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}\n`,
    [lineCount],
  );
  // `ch` is one character in this monospace face, so the digits fill the column exactly and it
  // steps out by one character when a file passes a power of ten. The constant is the gutter's
  // own padding.
  const gutterWidth = `calc(${String(lineCount).length}ch + 1.25rem)`;

  // Scroll the painted layer and the gutter with the textarea rather than letting each scroll on
  // its own, which is what makes the illusion hold once a file is longer or wider than the pane.
  // The gutter takes the vertical half only: it stays put while the code scrolls sideways, the
  // way a gutter does everywhere else.
  const sync = () => {
    const control = input.current;
    if (!control) return;
    const layer = painted.current;
    if (layer) {
      layer.scrollTop = control.scrollTop;
      layer.scrollLeft = control.scrollLeft;
    }
    const numbered = gutter.current;
    if (numbered) numbered.scrollTop = control.scrollTop;
    const marked = band.current;
    if (marked && bandTop.current !== null) {
      marked.style.transform = `translateY(${bandTop.current - control.scrollTop}px)`;
    }
  };

  // Take the reader to a revealed line: a third of the way down the pane, so the lines before it
  // give it context, with the match selected so the caret is already there when they click in.
  // Not focused: on a phone, focus opens the keyboard over the line it just scrolled to.
  useDomSync(() => {
    const control = input.current;
    if (!control || !reveal || applied.current === reveal.nonce) return;
    applied.current = reveal.nonce;
    const { offset, lineLength, top, height } = lineGeometry(control, text, reveal.line);
    control.scrollTop = Math.max(0, top - control.clientHeight / 3);
    const start = Math.min(reveal.start, lineLength);
    const end = Math.min(Math.max(reveal.end, start), lineLength);
    control.setSelectionRange(offset + start, offset + end);
    // Horizontally only when the match would be off the right edge; one character is about 0.6em
    // in this face, which is close enough to land it in view.
    const column = start * 13 * 0.6;
    control.scrollLeft = column > control.clientWidth * 0.8 ? column - control.clientWidth / 3 : 0;
    bandTop.current = top;
    if (band.current) {
      band.current.style.height = `${height}px`;
      band.current.style.transform = `translateY(${top - control.scrollTop}px)`;
    }
    sync();
  }, [reveal, text]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      {/* Hidden from the reading order and from the pointer: a screen reader meeting the textarea
          should hear the file, not a column of integers, and a number is not something to click. */}
      <pre
        ref={gutter}
        aria-hidden
        style={{ width: gutterWidth }}
        className={`${LAYER} pointer-events-none absolute inset-y-0 left-0 select-none
          overflow-hidden border-r border-border/60 pl-3 pr-2 text-right
          text-muted-foreground/70`}
      >
        {numbers}
      </pre>
      {/* Under the painted text, so the line reads through it; hidden until a reveal places it. */}
      <div
        ref={band}
        aria-hidden
        style={{ left: gutterWidth, display: reveal ? undefined : "none" }}
        className="pointer-events-none absolute right-0 top-0 bg-primary/15"
      />
      {html ? (
        <pre
          ref={painted}
          aria-hidden
          style={{ left: gutterWidth }}
          className={`${LAYER} ${CODE} ${PAINTED} pointer-events-none absolute inset-y-0 right-0
              overflow-hidden`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        // Before the grammars load, the plain text stands in at identical metrics, so the
        // caret never sits over blank space and nothing reflows when highlighting arrives.
        <pre
          ref={painted}
          aria-hidden
          style={{ left: gutterWidth }}
          className={`${LAYER} ${CODE} pointer-events-none absolute inset-y-0 right-0
              overflow-hidden text-foreground`}
        >
          {`${text}\n`}
        </pre>
      )}
      <textarea
        ref={input}
        value={text}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        onScroll={sync}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        // The attribute rather than the CSS: `white-space` decides how the VALUE is painted, and
        // only `wrap` decides whether the control soft-wraps it in the first place.
        wrap="off"
        aria-label={`${readOnly ? "Source of" : "Edit"} ${path.split("/").pop() ?? path}`}
        style={{ left: gutterWidth }}
        className={`${LAYER} ${CODE} absolute inset-y-0 right-0 resize-none overflow-auto border-0
          bg-transparent text-transparent caret-foreground outline-none
          selection:bg-primary/30`}
      />
    </div>
  );
}
