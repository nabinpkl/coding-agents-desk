import { Folder, LoaderCircle, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { AddBotCommand, BotView, ProjectSummary } from "@agentdesk/agent-feed-wire";
import { BotAvatar } from "./BotSidebarPanel";

/**
 * The registry's own cap on a first turn, repeated here so the dialog refuses before the round
 * trip rather than after it.
 */
const MAXIMUM_FIRST_TURN = 32_768;

function metadataLines(value: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || !line.slice(separator + 1).trim()) {
      throw new Error('Metadata lines must use "key=value"');
    }
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return metadata;
}

export function BotCreatorDialog({
  open,
  projects,
  bots,
  inventoryLoading,
  onClose,
  onCreate,
}: {
  open: boolean;
  projects: ProjectSummary[];
  bots: BotView[];
  inventoryLoading: boolean;
  onClose: () => void;
  onCreate: (command: Omit<AddBotCommand, "requestId">) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [name, setName] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [customMetadata, setCustomMetadata] = useState("");
  const [canAddBots, setCanAddBots] = useState(false);
  // On by default: a Bot is a directory and the sessions working in it, and creating one almost
  // always means starting the first. Turning it off is how an existing session's directory gets
  // adopted without spawning a second agent into it.
  const [startSession, setStartSession] = useState(true);
  const [firstTurn, setFirstTurn] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claimedDirectories = useMemo(
    () => new Set(bots.map((bot) => bot.environment.path)),
    [bots],
  );

  useEffect(() => {
    if (!open) return;
    setSelectedProject(null);
    setName("");
    setIconUrl("");
    setRole("");
    setDescription("");
    setLabels("");
    setCustomMetadata("");
    setCanAddBots(false);
    setStartSession(true);
    setFirstTurn("");
    setPending(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, [open]);

  useEffect(() => {
    if (selectedProject) globalThis.requestAnimationFrame?.(() => nameInput.current?.focus());
  }, [selectedProject]);

  if (!open) return null;

  /**
   * Loads a brief from a file into the first turn.
   *
   * The file is read HERE and sent as text, rather than handing the sidecar a path to open. A
   * grounding brief is usually a file and typing one into a textarea is absurd, but an API that
   * opens arbitrary paths on request is a file-read primitive, and this one is reachable by
   * anything on the tailnet. Reading it in the page costs nothing and keeps that door shut.
   */
  const loadBrief = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > MAXIMUM_FIRST_TURN) {
        throw new Error(`${file.name} is longer than ${MAXIMUM_FIRST_TURN} characters`);
      }
      setFirstTurn(text);
      setError(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProject || pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        ...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}),
        directoryPath: selectedProject.projectPath,
        metadata: {
          ...(role.trim() ? { role: role.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          labels: labels.split(",").map((label) => label.trim()).filter(Boolean),
          custom: metadataLines(customMetadata),
        },
        grants: canAddBots ? ["add_bot"] : [],
        // The title is left to the sidecar, which defaults it to the Bot's name. Two places
        // deciding what a session is called is how the canvas and `ListAgents` end up disagreeing.
        ...(startSession ? { launch: firstTurn.trim() ? { prompt: firstTurn } : {} } : {}),
      });
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="bot-creator-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section className="flex max-h-[min(760px,92dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
        <header className="flex min-h-12 shrink-0 items-center border-b border-border px-4">
          <div className="min-w-0 flex-1">
            <h2 id="bot-creator-title" className="text-base font-semibold">Add Bot</h2>
            <p className="text-xs text-muted-foreground">Name a Bot, bind its project directory, and start the session that works in it.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close Bot creator"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>

        <form onSubmit={submit} className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
          <div className="min-h-0 overflow-y-auto border-b border-border md:border-r md:border-b-0">
            <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Directory
            </div>
            {inventoryLoading && projects.length === 0 ? (
              <div role="status" className="flex min-h-32 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
                Loading projects…
              </div>
            ) : projects.length === 0 ? (
              <div role="status" className="flex min-h-32 items-center justify-center p-4 text-sm text-muted-foreground">
                No AgentDesk projects available
              </div>
            ) : (
              <fieldset className="p-2">
                <legend className="sr-only">Select Bot directory</legend>
                {projects.map((project) => {
                  const unavailable = claimedDirectories.has(project.projectPath);
                  return (
                    <label
                      key={project.projectPath}
                      className={`flex min-h-12 items-start gap-2 rounded-lg px-2 py-2 outline-none transition-colors ${
                        unavailable
                          ? "cursor-not-allowed text-muted-foreground"
                          : "cursor-pointer hover:bg-muted focus-within:ring-2 focus-within:ring-primary active:bg-muted/80"
                      }`}
                    >
                      <input
                        type="radio"
                        name="bot-directory"
                        value={project.projectPath}
                        checked={selectedProject?.projectPath === project.projectPath}
                        disabled={unavailable}
                        onChange={() => {
                          setSelectedProject(project);
                          setError(null);
                        }}
                        className="mt-1"
                      />
                      <Folder className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{project.displayName || project.projectPath}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{project.projectPath}</span>
                        {unavailable ? <span className="text-xs">already assigned to a Bot</span> : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            {!selectedProject ? (
              <div className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
                Choose the existing directory this Bot represents.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
                  <BotAvatar bot={{ name: name || "New Bot", ...(iconUrl ? { iconUrl } : {}) }} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{name || "New Bot"}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{selectedProject.projectPath}</p>
                  </div>
                </div>
                <label className="block text-sm font-medium">
                  Name
                  <input
                    ref={nameInput}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={64}
                    placeholder="Release Captain"
                    className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Icon URL <span className="font-normal text-muted-foreground">optional, https</span>
                  <input
                    type="url"
                    value={iconUrl}
                    onChange={(event) => setIconUrl(event.target.value)}
                    placeholder="https://…"
                    className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Role <span className="font-normal text-muted-foreground">optional</span>
                  <input
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                    maxLength={120}
                    placeholder="Coordinates release work"
                    className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Description <span className="font-normal text-muted-foreground">optional</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    className="mt-1 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Labels <span className="font-normal text-muted-foreground">optional, comma separated</span>
                  <input
                    value={labels}
                    onChange={(event) => setLabels(event.target.value)}
                    placeholder="release, platform"
                    className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Metadata <span className="font-normal text-muted-foreground">optional, one key=value per line</span>
                  <textarea
                    value={customMetadata}
                    onChange={(event) => setCustomMetadata(event.target.value)}
                    rows={3}
                    placeholder="team=platform"
                    className="mt-1 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                </label>
                <div className="rounded-lg border border-border">
                  <label className="flex cursor-pointer items-start gap-2 p-3 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-primary active:bg-muted/70">
                    <input
                      type="checkbox"
                      checked={startSession}
                      onChange={(event) => setStartSession(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-sm">
                      <span className="block font-medium">Start a Claude session in this directory</span>
                      <span className="block text-xs text-muted-foreground">Runs in its own tmux pane, named after the Bot, and appears on the canvas.</span>
                    </span>
                  </label>
                  {startSession ? (
                    <div className="border-t border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          First turn <span className="font-normal text-muted-foreground">optional</span>
                        </span>
                        <label className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-within:ring-2 focus-within:ring-primary">
                          <Upload className="size-3.5" aria-hidden />
                          Load a brief
                          <input type="file" accept=".md,.txt,text/*" onChange={loadBrief} className="sr-only" />
                        </label>
                      </div>
                      <textarea
                        value={firstTurn}
                        onChange={(event) => setFirstTurn(event.target.value)}
                        maxLength={MAXIMUM_FIRST_TURN}
                        rows={5}
                        placeholder="Familiarize yourself with the existing work, then report what the last arc left open."
                        className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {firstTurn.trim()
                          ? `${firstTurn.length.toLocaleString()} characters`
                          : "Left empty, the session starts and waits."}
                      </p>
                    </div>
                  ) : null}
                </div>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-primary active:bg-muted/70">
                  <input
                    type="checkbox"
                    checked={canAddBots}
                    onChange={(event) => setCanAddBots(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    <span className="block font-medium">Allow this Bot to create Bots</span>
                    <span className="block text-xs text-muted-foreground">The tool becomes available to an attached Pi session when its runtime opens.</span>
                  </span>
                </label>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              </div>
            )}
          </div>

          <footer className="flex min-h-14 items-center justify-end gap-2 border-t border-border px-4 md:col-span-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="min-h-10 rounded-lg px-4 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedProject || !name.trim() || pending}
              className="flex min-h-10 min-w-24 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
              {pending ? "Adding…" : "Add Bot"}
            </button>
          </footer>
        </form>
      </section>
    </dialog>
  );
}
