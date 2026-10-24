// A session on no Bot: which directory, which harness, what it is called, and what it starts on.
//
// Beside the Bot dialogs because it is built from their parts -- the directory column the Bot
// creator binds with, and the harness choice the session picker offers -- and is the same act
// without the Bot. The session can be put on one afterwards, from the modal it opens in.

import { LoaderCircle, SquareTerminal, X } from "lucide-react";
import { useCallback, useRef, type SubmitEvent } from "react";
import type { ProjectSummary, StartSessionCommand } from "@agentdesk/agent-feed-wire";
import type { BotMachine } from "@/features/bots/botMachines";
import { BotDirectoryColumn } from "@/features/bots/dialogs/BotDirectoryColumn";
import { HARNESSES, harnessStart, type NewSessionHarness } from "@/features/bots/dialogs/BotSessionPickerDialog";
import { useModal } from "@/hooks/dom/overlays";
import { useStateFor } from "@/hooks/state/useStateFor";

const NO_CLAIMS: ReadonlySet<string> = new Set();

export function NewSessionDialog({
  open,
  machine,
  projects,
  loading,
  onClose,
  onStart,
}: {
  open: boolean;
  /** The machine the Sessions view reads, which is the one the session starts on. */
  machine: BotMachine;
  projects: ProjectSummary[];
  loading: boolean;
  onClose: () => void;
  /** Starts it and closes this dialog, or throws for the reason to show here. */
  onStart: (command: StartSessionCommand) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedPath, setSelectedPath] = useStateFor<string | null>(open, () => null);
  // The SDK runner is how a Claude session runs now; the terminal UI is kept for sessions already in it.
  const [harness, setHarness] = useStateFor<NewSessionHarness>(open, () => "claude-sdk");
  const [title, setTitle] = useStateFor(open, () => "");
  const [prompt, setPrompt] = useStateFor(open, () => "");
  const [pending, setPending] = useStateFor(open, () => false);
  const [error, setError] = useStateFor<string | null>(open, () => null);

  const browse = useCallback((path: string | null) => machine.feed.browseDirectories(path), [machine]);
  const createFolder = useCallback((path: string, name: string) => machine.feed.createDirectory(path, name), [machine]);

  useModal(dialogRef, Boolean(open), { attributeFallback: true });

  if (!open) return null;

  // Claude, either way it runs, starts only with its first turn: one started bare writes no
  // transcript, so nothing can resume it. opencode keeps a session at its serve from the start.
  const needsMessage = harness !== "opencode" && !prompt.trim();
  const ready = Boolean(selectedPath) && Boolean(title.trim()) && !needsMessage;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending || !selectedPath || !ready) return;
    setPending(true);
    setError(null);
    try {
      await onStart({
        ...harnessStart(harness),
        projectPath: selectedPath,
        title: title.trim(),
        ...(prompt.trim() ? { prompt } : {}),
      });
    } catch (reason) {
      // Every field stays as it was, the first message included, so a retry is one click.
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="new-session-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section className="flex max-h-[min(720px,92dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
        <header className="flex min-h-12 shrink-0 items-center border-b border-border px-4">
          <h2 id="new-session-title" className="min-w-0 flex-1 truncate text-base font-semibold">
            New session
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close new session"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>

        <form onSubmit={submit} className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
          <BotDirectoryColumn
            machines={[machine]}
            machine={machine}
            onMachine={() => {}}
            projects={projects}
            loading={loading}
            error={null}
            claimed={NO_CLAIMS}
            selectedPath={selectedPath}
            onSelect={(path) => {
              setSelectedPath(path);
              setError(null);
            }}
            browse={browse}
            createFolder={createFolder}
          />

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <p className={`truncate font-mono text-xs ${selectedPath ? "text-foreground" : "text-muted-foreground"}`}>
              {selectedPath ?? "Choose the directory it runs in."}
            </p>
            <fieldset className="flex gap-1 rounded-lg border border-border p-1">
              <legend className="sr-only">Harness</legend>
              {HARNESSES.map((option) => (
                <label
                  key={option.value}
                  className="flex min-h-9 flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground has-checked:bg-muted has-checked:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-primary has-disabled:cursor-not-allowed has-disabled:opacity-50"
                >
                  <input
                    type="radio"
                    name="new-session-harness"
                    value={option.value}
                    checked={harness === option.value}
                    onChange={() => setHarness(option.value)}
                    disabled={pending}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <label className="block text-sm font-medium">
              Name
              {/* Capped where the catalog truncates, so a stored title is always the one shown. */}
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={240}
                disabled={pending}
                className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            <label className="block text-sm font-medium">
              First message
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={5}
                maxLength={32_768}
                required={harness !== "opencode"}
                disabled={pending}
                placeholder={harness === "opencode" ? "Optional" : undefined}
                className="mt-1 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="mt-auto flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="min-h-10 cursor-pointer rounded-lg px-4 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || !ready}
                aria-busy={pending || undefined}
                className="flex min-h-10 min-w-28 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                ) : (
                  <SquareTerminal className="size-4" aria-hidden />
                )}
                {pending ? "Starting…" : "Start session"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </dialog>
  );
}
