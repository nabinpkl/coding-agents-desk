// The editable code surface.
//
// A textarea over a highlighted `<pre>`, both in the same monospace metrics and scrolled together.
// The textarea is transparent apart from its caret and selection, so what the reader sees is the
// highlighted layer and what they type into is a plain form control.
//
// CodeMirror was the plan and is not here, because `bun add` cannot reach the npm registry from
// this machine: every attempt fails TLS verification on a different package (`bun add` resolves
// some manifests and rejects others on each run, while `npm view` against the same registry
// succeeds). Working around that means disabling certificate verification or adding a second
// lockfile, and both are worse than this. `TASKS.md` carries the swap; it is one file.
//
// What this costs against CodeMirror, so nobody discovers it as a surprise: no bracket matching,
// no multiple cursors, no folding, and no virtualisation, so a very large file lays out all of its
// lines. What it keeps: highlighting, the browser's own undo, find, spellcheck-off, and a caret
// that behaves the way every other text field on the machine does.

import { useEffect, useMemo, useRef } from "react";
import { SHIKI_THEMES, useCodeHighlighting } from "@/features/activity-feed/markdown/highlighter";
// The colours the painted layer wears. Imported here rather than relied on from a neighbour,
// because the rule that reads Shiki's per-token variables is what makes this surface coloured at
// all, and an editor that depends on a stylesheet nothing here mentions is one import away from
// silently going grey again.
import "@/features/activity-feed/markdown/markdown.css";

/** Shared metrics, so the two layers agree character for character. */
const LAYER = "m-0 p-3 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap break-words";

/**
 * Shiki hands back its own `<pre class="shiki">`, which lands INSIDE the layer above.
 *
 * Left alone it keeps a `<pre>`'s own `white-space: pre` while the textarea over it wraps, so a
 * long line occupies one row in one layer and three in the other and the caret walks away from
 * the text. These push the outer layer's metrics onto it so the two stay character for character.
 */
const PAINTED = "[&_.shiki]:m-0 [&_.shiki]:bg-transparent [&_.shiki]:whitespace-pre-wrap"
  + " [&_.shiki]:break-words [&_.shiki]:font-[inherit] [&_.shiki]:text-[length:inherit]"
  + " [&_.shiki]:leading-[inherit]";

export function CodeEditor({
  path,
  text,
  readOnly,
  onChange,
}: {
  path: string;
  text: string;
  readOnly: boolean;
  onChange: (text: string) => void;
}) {
  // The path, not an extension pulled off it: the highlighter takes a file name as readily as a
  // fence language, which is what gives `Justfile` and `Dockerfile` a grammar at all.
  const { highlighter, lang } = useCodeHighlighting(path);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const painted = useRef<HTMLPreElement | null>(null);

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

  // Scroll the painted layer with the textarea rather than letting each scroll on its own, which
  // is what makes the illusion hold once a file is longer than the pane.
  useEffect(() => {
    const control = input.current;
    if (!control) return;
    const sync = () => {
      const layer = painted.current;
      if (!layer) return;
      layer.scrollTop = control.scrollTop;
      layer.scrollLeft = control.scrollLeft;
    };
    control.addEventListener("scroll", sync);
    sync();
    return () => control.removeEventListener("scroll", sync);
  }, []);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      {html
        ? (
          <pre
            ref={painted}
            aria-hidden
            className={`${LAYER} ${PAINTED} pointer-events-none absolute inset-0
              overflow-hidden`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )
        : (
          // Before the grammars load, the plain text stands in at identical metrics, so the
          // caret never sits over blank space and nothing reflows when highlighting arrives.
          <pre
            ref={painted}
            aria-hidden
            className={`${LAYER} pointer-events-none absolute inset-0 overflow-hidden
              text-foreground`}
          >
            {`${text}\n`}
          </pre>
        )}
      <textarea
        ref={input}
        value={text}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={`Edit ${path.split("/").pop() ?? path}`}
        className={`${LAYER} absolute inset-0 h-full w-full resize-none overflow-auto border-0
          bg-transparent text-transparent caret-foreground outline-none
          selection:bg-primary/30`}
      />
    </div>
  );
}
