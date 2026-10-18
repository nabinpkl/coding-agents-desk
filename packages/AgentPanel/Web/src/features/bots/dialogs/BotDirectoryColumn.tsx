// Which directory a Bot is, and which machine that directory is on.
//
// Two ways to answer, because there were two questions hiding in one list. The project list is
// "which of the directories agents already work in", and it is the common case. The folder picker
// is "the one they have not worked in yet" -- a project whose first session is the one this dialog
// is about to start, which by definition has no transcripts and so appears in no catalog.
//
// The picker is served rather than native: nothing in the web platform hands a page an absolute
// directory path, `<input webkitdirectory>` included, so the sidecar lists and the panel draws. It
// lists the machine selected HERE, which is the whole reason this is not a plain `<input>`: a path
// is not an address, and two peers can both have `/home/ubuntu/projects/x`.

import { useState } from "react";
import { Folder, FolderSearch, LoaderCircle, Monitor } from "lucide-react";
import type { ProjectSummary, WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";
import { machineKey, type BotMachine } from "@/features/bots/botMachines";
import { WorkspacePicker } from "@/features/workspace-ide/sidebar/WorkspacePicker";

/** The last segment of a path, which is what a folder is called when nothing else names it. */
function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function BotDirectoryColumn({
  machines,
  machine,
  onMachine,
  projects,
  loading,
  error,
  claimed,
  selectedPath,
  onSelect,
  browse,
  createFolder,
}: {
  /** Every sidecar a Bot can be created on, home first. One machine hides the picker entirely. */
  machines: readonly BotMachine[];
  machine: BotMachine;
  onMachine: (machine: BotMachine) => void;
  /** The selected machine's directories, as its catalog knows them. */
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  /** Directories already bound to a Bot ON THIS MACHINE, which the registry would refuse. */
  claimed: ReadonlySet<string>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  browse: (path: string | null) => Promise<WorkspaceBrowseListing>;
  /** Makes a folder on the machine this column is pointed at, for the same picker `browse` serves. */
  createFolder: (path: string, name: string) => Promise<WorkspaceBrowseListing>;
}) {
  const [picking, setPicking] = useState(false);
  // A folder chosen through the picker, kept so it has a row to be selected in: it is not in the
  // catalog, so the list it would otherwise appear in does not know about it.
  const [browsed, setBrowsed] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const rows = [
    ...(browsed && !projects.some((project) => project.projectPath === browsed)
      ? [{ projectPath: browsed, displayName: folderName(browsed) }]
      : []),
    ...projects.map((project) => ({
      projectPath: project.projectPath,
      displayName: project.displayName || project.projectPath,
    })),
  ];

  return (
    <div className="min-h-0 overflow-y-auto border-b border-border md:border-r md:border-b-0">
      <div className="sticky top-0 z-10 border-b border-border bg-card">
        {/* Only when there is a choice. One machine means every directory is on it, and a
            picker with a single option is a control that teaches the reader nothing. */}
        {machines.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only" id="bot-creator-machine">
              Machine
            </span>
            <div role="group" aria-labelledby="bot-creator-machine" className="flex flex-wrap gap-1.5">
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
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Directory</span>
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
      </div>

      {refusal ? (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}

      {loading && rows.length === 0 ? (
        <div
          role="status"
          className="flex min-h-32 items-center justify-center gap-2 p-4 text-sm text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Loading projects…
        </div>
      ) : rows.length === 0 ? (
        <div
          role="status"
          className="flex min-h-32 items-center justify-center p-4 text-center text-sm text-muted-foreground"
        >
          {error ?? `No AgentDesk projects on ${machine.label}. Browse for a folder instead.`}
        </div>
      ) : (
        <fieldset className="p-2">
          <legend className="sr-only">Select Bot directory</legend>
          {rows.map((row) => {
            const unavailable = claimed.has(row.projectPath);
            return (
              <label
                key={row.projectPath}
                className={`flex min-h-12 items-start gap-2 rounded-lg px-2 py-2 outline-none transition-colors ${
                  unavailable
                    ? "cursor-not-allowed text-muted-foreground"
                    : "cursor-pointer hover:bg-muted focus-within:ring-2 focus-within:ring-primary active:bg-muted/80"
                }`}
              >
                <input
                  type="radio"
                  name="bot-directory"
                  value={row.projectPath}
                  checked={selectedPath === row.projectPath}
                  disabled={unavailable}
                  onChange={() => onSelect(row.projectPath)}
                  className="mt-1"
                />
                <Folder className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{row.displayName}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{row.projectPath}</span>
                  {unavailable ? <span className="text-xs">already assigned to a Bot</span> : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {picking ? (
        <WorkspacePicker
          browse={browse}
          createFolder={createFolder}
          title={`Choose a folder on ${machine.label}`}
          confirmLabel="Use this folder"
          onCancel={() => setPicking(false)}
          onChoose={(path) => {
            setPicking(false);
            // Refused here rather than on submit, because the registry refuses it too and the
            // reader would otherwise fill the whole form in before hearing about it.
            if (claimed.has(path)) {
              setBrowsed(null);
              setRefusal(`${path} is already assigned to a Bot.`);
              return;
            }
            setBrowsed(path);
            onSelect(path);
          }}
        />
      ) : null}
    </div>
  );
}
