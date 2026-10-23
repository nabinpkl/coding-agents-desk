// Which files each contestant touched, as a matrix: a row per file, a column per lane.
//
// The rows are paths as the repository names them, not as each worktree does, so a file two
// contestants both read is one row with two marks -- the overlap, and the file only one of them
// thought to open, are what this view is for. Files a contestant read from outside its checkout
// (a global config, a plugin's own file) are kept, under their own heading, because what a
// harness's context made it read is a fact about the run too. Under the matrix, every place each
// contestant reached outside its own worktree by any tool -- a shell command's paths included --
// with a reach into a rival's worktree said as such.

import type { ArenaContestantDetail, ArenaOutsideReach } from "@agentdesk/agent-feed-wire";
import { fileMatrix, type FileRow, type FileTouch } from "@/features/arena/run/arenaFacts";
import { isLive, laneLabel, TEXT } from "@/features/arena/arenaVocabulary";

const TOUCH: Record<FileTouch, { word: string; ink: string }> = {
  read: { word: "read", ink: "border-border text-foreground" },
  written: { word: "wrote", ink: "border-arena-added text-arena-added" },
  both: { word: "read + wrote", ink: "border-arena-added text-arena-added" },
};

export function ArenaFilesMatrix({ contestants }: { contestants: readonly ArenaContestantDetail[] }) {
  const rows = fileMatrix(contestants);
  if (rows.length === 0) {
    return (
      <>
        <p className={`px-5 py-8 ${TEXT.body} text-muted-foreground`}>
          {contestants.some(isLive)
            ? "No files yet. They are recorded as each contestant closes."
            : "No contestant named a file."}
        </p>
        <OutsideReaches contestants={contestants} />
      </>
    );
  }
  const inside = rows.filter((row) => row.inRepository);
  const outside = rows.filter((row) => !row.inRepository);
  return (
    <div className="overflow-x-auto px-5 py-4">
      <table className="w-full min-w-max border-separate border-spacing-0">
        <thead>
          <tr>
            <th
              scope="col"
              className={`sticky left-0 z-10 bg-background pb-2 pr-6 text-left ${TEXT.meta} font-medium text-muted-foreground`}
            >
              File
            </th>
            {contestants.map((contestant) => (
              <th
                key={contestant.contestantId}
                scope="col"
                className={`min-w-28 pb-2 pr-4 text-left ${TEXT.meta} font-medium text-muted-foreground`}
              >
                <span className="font-mono">{contestant.contestantId}</span> {laneLabel(contestant)}
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
      <OutsideReaches contestants={contestants} />
    </div>
  );
}

const HOW: Record<ArenaOutsideReach["how"], string> = {
  read: "read",
  write: "wrote",
  search: "searched",
  shell: "in a command",
};

/** Every place outside its own worktree each contestant reached, one row per place. */
function OutsideReaches({ contestants }: { contestants: readonly ArenaContestantDetail[] }) {
  const byPath = new Map<string, { rival: string | null; lanes: Map<number, Set<string>> }>();
  contestants.forEach((contestant, lane) => {
    for (const reach of contestant.outsideReached) {
      const row = byPath.get(reach.path) ?? { rival: reach.rival, lanes: new Map() };
      const hows = row.lanes.get(lane) ?? new Set<string>();
      hows.add(HOW[reach.how]);
      row.lanes.set(lane, hows);
      byPath.set(reach.path, row);
    }
  });
  if (byPath.size === 0) return null;
  return (
    <section aria-label="Reached outside their folders" className="pt-6">
      <h3 className={`pb-1.5 ${TEXT.meta} font-medium text-muted-foreground`}>Reached outside their folders</h3>
      <table className="w-full min-w-max border-separate border-spacing-0">
        <tbody className="[&>tr>*]:border-t [&>tr>*]:border-border">
          {[...byPath].map(([path, row]) => (
            <tr key={path} className="hover:bg-muted/50">
              <th
                scope="row"
                title={path}
                className={`sticky left-0 z-10 max-w-[28rem] truncate bg-background py-1.5 pr-6 text-left font-mono ${TEXT.meta} font-normal text-foreground`}
              >
                {row.rival ? <span className="font-sans text-destructive">{row.rival}'s · </span> : null}
                {path}
              </th>
              {contestants.map((contestant, lane) => {
                const hows = row.lanes.get(lane);
                return (
                  <td key={contestant.contestantId} className={`min-w-28 py-1.5 pr-4 ${TEXT.meta}`}>
                    {hows ? (
                      <span className={row.rival ? "text-destructive" : "text-foreground"}>{[...hows].join(", ")}</span>
                    ) : (
                      <span aria-label="not reached" className="text-muted-foreground">
                        ·
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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
                  <span aria-label="not touched" className={`${TEXT.meta} text-muted-foreground`}>
                    ·
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  );
}
