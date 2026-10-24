// Which project a thing starts in, and which machine that project is on: the one picker the new
// session dialog, the Bot creator, the arena's new run and the IDE's new workspace (through
// `ProjectPickerDialog`) all choose a directory with.
//
// Two ways to answer, because there were two questions hiding in one list. The project list is
// "which of the directories agents already work in", and it is the common case; the search over it
// is for the reader with many. The folder browser is "the one they have not worked in yet" -- a
// project whose first session is the one about to start, which by definition has no transcripts
// and so appears in no catalog -- and it is where a new folder is made.
//
// The browser is served rather than native: nothing in the web platform hands a page an absolute
// directory path, `<input webkitdirectory>` included, so the sidecar lists and the panel draws. It
// lists the machine selected HERE, which is the whole reason this is not a plain `<input>`: a path
// is not an address, and two peers can both have `/home/ubuntu/projects/x`.
//
// The caller sizes it (`className`): a dialog's column, or a box in a form.

import { useId, useState } from "react";
import { Folder, FolderPlus, FolderSearch, LoaderCircle, Monitor } from "lucide-react";
import type { ProjectSummary, WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";
import { machineKey, type BotMachine } from "@/features/bots/botMachines";
import { FolderBrowser } from "@/features/project-picker/FolderBrowser";

/** The last segment of a path, which is what a folder is called when nothing else names it. */
function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** Whether a project holds every word of the search, in its name or its path, ignoring case. */
export function projectMatches(project: { projectPath: string; displayName: string }, search: string): boolean {
  const haystack = `${project.displayName}\n${project.projectPath}`.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

const ROW = "flex min-h-12 items-start gap-2 rounded-lg px-2 py-2 outline-none transition-colors";
// Half the muted wash on hover: the full one took a row's grey path to 4.3:1, under the 4.5:1 line.
const ROW_ACTIVE = "cursor-pointer hover:bg-muted/50 focus-within:ring-2 focus-within:ring-primary active:bg-muted/80";

export function ProjectPicker({
  heading = "Directory",
  machines,
  machine,
  onMachine,
  projects,
  loading,
  error,
  describe,
  selectedPath,
  onSelect,
  noPathOption,
  browse,
  createFolder,
  className,
}: {
  /** What the chosen directory is to the caller: a session's directory, a run's repository. */
  heading?: string;
  /** Every sidecar the thing can start on, home first. One machine hides the machine row. */
  machines: readonly BotMachine[];
  machine: BotMachine;
  onMachine?: (machine: BotMachine) => void;
  /** The selected machine's directories, as its catalog knows them. */
  projects: readonly ProjectSummary[];
  loading: boolean;
  error: string | null;
  /**
   * What the caller has to say about a directory, under its path: why it would refuse it ("already
   * assigned to a Bot"), which also disables its row, or what choosing it means. Null for nothing.
   */
  describe?: (path: string) => { note: string; refused: boolean } | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /**
   * A first row that chooses no directory, for a caller where none means something of its own
   * (an arena run then makes a repository of its own). Checked while `selectedPath` is null.
   */
  noPathOption?: { label: string; detail: string; onSelect: () => void };
  browse: (path: string | null) => Promise<WorkspaceBrowseListing>;
  /** Makes a folder on the machine this picker is pointed at, for the browser `browse` serves. */
  createFolder: (path: string, name: string) => Promise<WorkspaceBrowseListing>;
  className: string;
}) {
  const radioName = useId();
  const machineLabel = useId();
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  // A folder chosen through the browser, kept so it has a row to be selected in: it is not in the
  // catalog, so the list it would otherwise appear in does not know about it.
  const [browsed, setBrowsed] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The selection always has a row too: a caller that outlives this picker (the arena's draft, kept
  // while the reader looks at a run) hands back a browsed folder this picker no longer remembers.
  const outsideCatalog = [...new Set([browsed, selectedPath])].filter(
    (path): path is string => path !== null && !projects.some((project) => project.projectPath === path),
  );
  const rows = [
    ...outsideCatalog.map((path) => ({ projectPath: path, displayName: folderName(path) })),
    ...projects.map((project) => ({
      projectPath: project.projectPath,
      displayName: project.displayName || project.projectPath,
    })),
  ];
  // Projects named for the search before those that only hold it in their path: searching "desk"
  // wants agent-desk, not every scratch folder somewhere under it.
  const matched = rows.filter((row) => projectMatches(row, search));
  const shown = [
    ...matched.filter((row) => projectMatches({ projectPath: "", displayName: row.displayName }, search)),
    ...matched.filter((row) => !projectMatches({ projectPath: "", displayName: row.displayName }, search)),
  ];

  return (
    <div className={className}>
      <div className="sticky top-0 z-10 border-b border-border bg-card">
        {/* Only when there is a choice. One machine means every directory is on it, and a
            picker with a single option is a control that teaches the reader nothing. */}
        {machines.length > 1 && onMachine ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only" id={machineLabel}>
              Machine
            </span>
            <div role="group" aria-labelledby={machineLabel} className="flex flex-wrap gap-1.5">
              {machines.map((candidate) => {
                const selected = candidate.id === machine.id;
                return (
                  <button
                    key={machineKey(candidate)}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      if (selected) return;
                      onMachine(candidate);
                      // A directory belongs to one machine, so neither a selection nor a browsed
                      // folder can survive the move: keeping either would offer this machine's
                      // path as though it were on that one.
                      setBrowsed(null);
                      setRefusal(null);
                    }}
                    className={`min-h-8 rounded-full border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
                    }`}
                  >
                    {candidate.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-4 pt-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</span>
          <button
            type="button"
            onClick={() => {
              setRefusal(null);
              setPicking(true);
            }}
            className="flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
          >
            <FolderSearch className="size-3.5" aria-hidden />
            Browse folders
          </button>
        </div>
        <div className="px-4 pt-1 pb-2">
          <input
            type="search"
            aria-label="Search projects"
            placeholder="Search projects"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears the search rather than closing what holds the picker: it is about the
              // field the reader is in, and a dialog closing on a cleared query loses the form.
              if (event.key === "Escape" && search !== "") {
                event.preventDefault();
                event.stopPropagation();
                setSearch("");
              }
            }}
            spellCheck={false}
            autoComplete="off"
            className="min-h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </div>
      </div>

      {refusal ? (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}

      {/* A radio group by role rather than a fieldset: a fieldset is as wide as its widest line by
          default, so one long path pushed every row past the edge, and its hidden legend measured as
          clipped text. */}
      <div role="radiogroup" aria-label={`Select ${heading.toLowerCase()}`} className="min-w-0 p-2">
        {noPathOption ? (
          <label className={`${ROW} ${ROW_ACTIVE}`}>
            <input
              type="radio"
              name={radioName}
              checked={selectedPath === null}
              onChange={noPathOption.onSelect}
              className="mt-1"
            />
            <FolderPlus className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{noPathOption.label}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{noPathOption.detail}</span>
            </span>
          </label>
        ) : null}
        {loading && rows.length === 0 ? (
          <div
            role="status"
            className="flex min-h-24 items-center justify-center gap-2 p-4 text-sm text-muted-foreground"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Loading projects…
          </div>
        ) : rows.length === 0 ? (
          <div
            role="status"
            className="flex min-h-24 items-center justify-center p-4 text-center text-sm text-muted-foreground"
          >
            {error ?? `No AgentDesk projects on ${machine.label}. Browse for a folder instead.`}
          </div>
        ) : shown.length === 0 ? (
          <div
            role="status"
            className="flex min-h-24 items-center justify-center p-4 text-center text-sm text-muted-foreground"
          >
            No project matches “{search.trim()}”. Browse for a folder instead.
          </div>
        ) : (
          shown.map((row) => {
            const said = describe?.(row.projectPath) ?? null;
            const refused = said?.refused ?? false;
            return (
              <label
                key={row.projectPath}
                className={`${ROW} ${refused ? "cursor-not-allowed text-muted-foreground" : ROW_ACTIVE}`}
              >
                <input
                  type="radio"
                  name={radioName}
                  value={row.projectPath}
                  checked={selectedPath === row.projectPath}
                  disabled={refused}
                  onChange={() => onSelect(row.projectPath)}
                  className="mt-1"
                />
                <Folder className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{row.displayName}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{row.projectPath}</span>
                  {said ? <span className="block text-xs text-muted-foreground">{said.note}</span> : null}
                </span>
              </label>
            );
          })
        )}
      </div>

      {picking ? (
        <FolderBrowser
          browse={browse}
          createFolder={createFolder}
          title={`Choose a folder on ${machine.label}`}
          confirmLabel="Use this folder"
          onCancel={() => setPicking(false)}
          onChoose={(path) => {
            setPicking(false);
            // Refused here rather than on submit, because the caller refuses it too and the
            // reader would otherwise fill the whole form in before hearing about it.
            const said = describe?.(path);
            if (said?.refused) {
              setBrowsed(null);
              setRefusal(`${path}: ${said.note}`);
              return;
            }
            setBrowsed(path);
            // A folder just chosen is the one the reader wants to see, whatever they searched for.
            setSearch("");
            onSelect(path);
          }}
        />
      ) : null}
    </div>
  );
}
