// What each contestant left in its worktree, in its own lane under its facts.
//
// One collapsible block per file, each rendered by the same
// diff viewer the transcript's edit blocks use -- so a change reads here the way it reads in a
// session. A lane that changed nothing says so in its column rather than leaving it blank, since
// "this contestant wrote nothing" is a result, not a gap.

import { useMemo } from "react";
import { DiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";
import { splitDiff, type DiffFilePart } from "@/features/arena/arenaFacts";
import { TEXT } from "@/features/arena/arenaVocabulary";
import { languageFromPath, usePrefersDark } from "@/features/activity-feed/blocks/diff/DiffBlock";
import { useFontStore } from "@/features/activity-feed/reading-preferences/fontStore";

/** One contestant's diff, filling its lane under its facts: a collapsible block per file. */
export function DiffLane({ contestant }: { contestant: ArenaContestantDetail }) {
  const parts = useMemo(() => splitDiff(contestant.gitDiff ?? ""), [contestant.gitDiff]);
  return (
    <section aria-label={`${contestant.contestantId} diff`} className="flex min-w-0 flex-col gap-2 bg-background px-4 py-3">
      {parts.length === 0 ? (
        <p className={`py-4 ${TEXT.meta} text-muted-foreground`}>
          {contestant.status === "closed"
            ? "Changed nothing in its worktree."
            : contestant.status === "failed"
              ? "Failed before changing anything."
              : "The diff is taken when this contestant closes."}
        </p>
      ) : (
        parts.map((part) => <FileDiff key={part.path} part={part} />)
      )}
    </section>
  );
}

function FileDiff({ part }: { part: DiffFilePart }) {
  const isDark = usePrefersDark();
  const fontPx = useFontStore((state) => state.tokens.tile_diff);
  const { file, failure } = useMemo((): { file: DiffFile | null; failure: string | null } => {
    try {
      const lang = languageFromPath(part.path);
      const made = DiffFile.createInstance({
        oldFile: { fileName: part.path, fileLang: lang },
        newFile: { fileName: part.path, fileLang: lang },
        hunks: [part.text],
      });
      made.initTheme(isDark ? "dark" : "light");
      made.init();
      made.buildUnifiedDiffLines();
      return { file: made, failure: null };
    } catch (error) {
      return { file: null, failure: error instanceof Error ? error.message : String(error) };
    }
  }, [part.path, part.text, isDark]);

  return (
    <details open className="group overflow-hidden rounded-md border border-border">
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 bg-muted/40 px-2.5 py-1.5 ${TEXT.meta} outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring`}
      >
        <span aria-hidden className="text-muted-foreground transition-transform duration-150 group-open:rotate-90">›</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={part.path}>{part.path}</span>
        <span className="shrink-0 tabular-nums text-arena-added">+{part.added}</span>
        <span className="shrink-0 tabular-nums text-arena-removed">−{part.removed}</span>
      </summary>
      {file ? (
        <div style={{ fontSize: "var(--agent-panel-fs-tile-diff, 14px)" }}>
          <DiffView
            diffFile={file}
            diffViewMode={DiffModeEnum.Unified}
            diffViewHighlight
            diffViewWrap
            diffViewTheme={isDark ? "dark" : "light"}
            diffViewFontSize={fontPx}
          />
        </div>
      ) : failure ? (
        <div>
          <p className={`border-b border-border px-2.5 py-1 ${TEXT.meta} text-destructive`}>
            The viewer could not read this part ({failure}); shown as the plain diff.
          </p>
          <pre className={`overflow-x-auto p-2.5 font-mono ${TEXT.meta} leading-relaxed`}>
            {part.text.split("\n").map((line, index) => (
              <span
                key={index}
                className={`block ${line.startsWith("+") ? "text-arena-added" : line.startsWith("-") ? "text-arena-removed" : "text-foreground"}`}
              >
                {line || " "}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
    </details>
  );
}
