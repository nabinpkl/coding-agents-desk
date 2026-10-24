// The project picker on its own, as a dialog: for a surface whose only question is which folder,
// such as the IDE adding a workspace. The dialogs that ask more (a new session, a new Bot) and the
// arena's form put `ProjectPicker` beside their other fields instead.
//
// It reads the machine's projects only while it is open, the way the Bot creator reads a peer's.

import { useCallback, useState } from "react";
import type { BotMachine } from "@/features/bots/botMachines";
import { useMachineInventory } from "@/features/bots/useMachineInventory";
import { ProjectPicker } from "@/features/project-picker/ProjectPicker";

/** The project list alone: which sessions are in a project is not this dialog's question. */
const NO_PATHS: readonly string[] = [];

export function ProjectPickerDialog({
  machine,
  title,
  confirmLabel,
  describe,
  onChoose,
  onCancel,
}: {
  /** The machine whose projects are listed and whose folders are browsed. */
  machine: BotMachine;
  title: string;
  confirmLabel: string;
  describe?: (path: string) => { note: string; refused: boolean } | null;
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const inventory = useMachineInventory(machine, NO_PATHS);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const browse = useCallback((path: string | null) => machine.feed.browseDirectories(path), [machine]);
  const createFolder = useCallback((path: string, name: string) => machine.feed.createDirectory(path, name), [machine]);
  const chosen = selectedPath !== null && !describe?.(selectedPath)?.refused ? selectedPath : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <header className="shrink-0 border-b border-border px-4 py-3">
          <h2 className="m-0 text-sm font-medium">{title}</h2>
        </header>
        <ProjectPicker
          machines={[machine]}
          machine={machine}
          projects={inventory.projects}
          loading={inventory.loading}
          error={inventory.error}
          describe={describe}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          browse={browse}
          createFolder={createFolder}
          className="min-h-0 flex-1 overflow-y-auto"
        />
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm outline-none hover:bg-muted
              focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={chosen === null}
            onClick={() => chosen !== null && onChoose(chosen)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground outline-none
              hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
              active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
