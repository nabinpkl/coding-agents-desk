// One file's patch, drawn: both line numbers, the added and removed tints, and the file's own
// syntax colours on top.
//
// Takes a patch and nothing about where it came from, which is what lets a commit's diff in the IDE
// and a Bot's uncommitted change on the canvas be the same rows.

import { useMemo } from "react";
import { SHIKI_THEMES, useCodeHighlighting } from "@/features/activity-feed/markdown/highlighter";
// The rule that reads Shiki's per-token variables, for the reason the editor imports it too: a
// surface that emits perfectly tokenised markup and depends on a stylesheet nothing here mentions
// is one import away from silently going grey.
import "@/features/activity-feed/markdown/markdown.css";
import { parsePatch, patchSides, type PatchLine } from "@/features/workspace-ide/history/gitPatch";

/** What drawing a patch needs: the path names the grammar, and the cut is said out loud. */
export interface PatchSource {
  path: string;
  patch: string;
  truncated: boolean;
}

/**
 * The row's background, and the ink for anything the grammar does not colour.
 *
 * The tint is what says added or removed; the ink under the tokens is what a line falls back to
 * where shiki has no grammar, or has not loaded one yet. An added line therefore reads as added
 * before it is coloured and after, which is what keeps the panel from flashing a different shape
 * when the grammar arrives.
 */
const LINE_TONE: Record<PatchLine["kind"], string> = {
  hunk: "bg-muted text-muted-foreground",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  removed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  context: "text-foreground",
  meta: "text-muted-foreground",
};

/**
 * Past this many lines the patch is drawn without colour.
 *
 * Tokenizing runs on the main thread, and a generated file's rewrite is tens of thousands of lines
 * of it. A diff nobody can read because the panel froze is worse than a grey one.
 */
const HIGHLIGHT_LINE_CEILING = 3000;

/**
 * The patch, one row per line, with both files' line numbers in the gutter.
 *
 * Scrolled horizontally on its own rather than wrapped: a wrapped diff line loses the alignment
 * that makes two versions comparable, and this panel is narrow enough that wrapping would be the
 * common case rather than the exception.
 *
 * The colours are the panel's own highlighter, the same Shiki instance and grammars the editor
 * paints a file with, so a line looks the same in the diff as it does in the file it came from.
 */
export function PatchView({ diff }: { diff: PatchSource }) {
  const lines = useMemo(() => parsePatch(diff.patch), [diff.patch]);
  // The path rather than an extension: the highlighter takes a file name as readily as a fence
  // language, which is what gives `Justfile` and `Dockerfile` a grammar at all.
  const { highlighter, lang } = useCodeHighlighting(diff.path);
  const painted = useMemo(() => {
    if (!highlighter || lines.length > HIGHLIGHT_LINE_CEILING) return null;
    const sides = patchSides(lines);
    const options = { lang, themes: SHIKI_THEMES, defaultColor: false } as const;
    return {
      old: highlighter.codeToTokens(sides.oldCode, options).tokens,
      fresh: highlighter.codeToTokens(sides.newCode, options).tokens,
      places: sides.places,
    };
  }, [highlighter, lang, lines]);

  return (
    // The whole pane, scrolling in both directions: this is the editor's content now rather than a
    // box inside a list, so the only ceiling on it is the pane it fills.
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Named, because a screen reader meeting this otherwise meets an unlabelled wall of
            code with no way to tell which file it belongs to. */}
        <pre
          aria-label={`Diff of ${diff.path}`}
          className="m-0 w-max min-w-full p-0 font-mono text-[11px] leading-[18px]"
        >
          {lines.map((line, index) => {
            const place = painted?.places[index] ?? null;
            const tokens = place === null
              ? null
              : (place.side === "old" ? painted!.old : painted!.fresh)[place.line] ?? null;
            return (
              // The index is the key because a patch is a list of lines rather than of entities:
              // two identical lines are two rows, and nothing in it is reordered or removed.
              <div key={index} className={`flex ${LINE_TONE[line.kind]}`}>
                <span aria-hidden className="w-9 shrink-0 select-none px-1 text-right
                  text-muted-foreground/70"
                >
                  {line.oldNumber ?? ""}
                </span>
                <span aria-hidden className="w-9 shrink-0 select-none px-1 text-right
                  text-muted-foreground/70"
                >
                  {line.newNumber ?? ""}
                </span>
                {/* `shiki` on the code span and not on the row, because the rule that reads the
                    per-token variables paints every span under it -- and the two gutters are
                    spans with no token colour of their own to read. */}
                <span className={`whitespace-pre px-2 ${tokens ? "shiki" : ""}`}>
                  {tokens
                    ? tokens.map((token, at) => (
                      <span key={at} style={token.htmlStyle}>{token.content}</span>
                    ))
                    : line.text}
                </span>
              </div>
            );
          })}
        </pre>
      </div>
      {diff.truncated
        ? (
          <p className="m-0 shrink-0 border-t border-border px-2 py-1 text-[11px]
            text-muted-foreground">
            This diff was cut short. Read the rest in a terminal.
          </p>
        )
        : null}
    </div>
  );
}
