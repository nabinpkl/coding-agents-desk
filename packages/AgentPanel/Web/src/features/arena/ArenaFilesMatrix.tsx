// Which files each contestant touched, as a matrix: a row per file, a column per lane.
//
// The rows are paths as the repository names them, not as each worktree does, so a file two
// contestants both read is one row with two marks -- the overlap, and the file only one of them
// thought to open, are what this view is for. Files a contestant read from outside its checkout
// (a global config, a plugin's own file) are kept, under their own heading, because what a
// harness's context made it read is a fact about the run too.

import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";
import { fileMatrix, type FileRow, type FileTouch } from "@/features/arena/arenaFacts";
import { SOURCE_LABEL, TEXT } from "@/features/arena/arenaVocabulary";

const TOUCH: Record<FileTouch, { word: string; ink: string }> = {
  read: { word: "read", ink: "border-border text-foreground" },
  written: { word: "wrote", ink: "border-arena-added text-arena-added" },
  both: { word: "read + wrote", ink: "border-arena-added text-arena-added" },
};

export function ArenaFilesMatrix({ contestants }: { contestants: readonly ArenaContestantDetail[] }) {
  const rows = fileMatrix(contestants);
  if (rows.length === 0) {
    return (
      <p className={`px-5 py-8 ${TEXT.body} text-muted-foreground`}>
        {contestants.some((c) => c.status === "running" || c.status === "preparing")
          ? "No files yet. They are recorded as each contestant closes."
          : "No contestant named a file."}
      </p>
    );
  }
  const inside = rows.filter((row) => row.inRepository);
  const outside = rows.filter((row) => !row.inRepository);
  return (
    <div className="overflow-x-auto px-5 py-4">
      <table className="w-full min-w-max border-separate border-spacing-0">
        <thead>
          <tr>
            <th scope="col" className={`sticky left-0 z-10 bg-background pb-2 pr-6 text-left ${TEXT.meta} font-medium text-muted-foreground`}>
              File
            </th>
            {contestants.map((contestant) => (
              <th key={contestant.contestantId} scope="col" className={`min-w-28 pb-2 pr-4 text-left ${TEXT.meta} font-medium text-muted-foreground`}>
                <span className="font-mono">{contestant.contestantId}</span> {SOURCE_LABEL[contestant.source]}
              </th>
            ))}
          </tr>
        </thead>
        <MatrixGroup rows={inside} lanes={contestants.length} />
        {outside.length > 0 ? (
          <>
            <tbody>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={contestants.length + 1}
                  className={`sticky left-0 pt-5 pb-1.5 text-left ${TEXT.meta} font-medium text-muted-foreground`}
                >
                  Outside the repository
                </th>
              </tr>
            </tbody>
            <MatrixGroup rows={outside} lanes={contestants.length} />
          </>
        ) : null}
      </table>
    </div>
  );
}

function MatrixGroup({ rows, lanes }: { rows: readonly FileRow[]; lanes: number }) {
  return (
    <tbody className="[&>tr>*]:border-t [&>tr>*]:border-border">
      {rows.map((row) => (
        <tr key={row.path} className="hover:bg-muted/50">
          <th
            scope="row"
            title={row.path}
            className={`sticky left-0 z-10 max-w-[28rem] truncate bg-background py-1.5 pr-6 text-left font-mono ${TEXT.meta} font-normal text-foreground`}
          >
            {row.path}
          </th>
          {Array.from({ length: lanes }, (_, lane) => {
            const touch = row.touches[lane] ?? null;
            return (
              <td key={lane} className="py-1.5 pr-4">
                {touch ? (
                  <span className={`inline-flex rounded border px-1.5 ${TEXT.meta} leading-5 ${TOUCH[touch].ink}`}>
                    {TOUCH[touch].word}
                  </span>
                ) : (
                  <span aria-label="not touched" className={`${TEXT.meta} text-muted-foreground`}>·</span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  );
}
