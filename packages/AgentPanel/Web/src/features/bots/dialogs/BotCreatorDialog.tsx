import { LoaderCircle, Upload, X } from "lucide-react";
import { useCallback, useMemo, useRef, type ChangeEvent, type SubmitEvent } from "react";
import type { AddBotCommand, BotView, ProjectSummary } from "@agentdesk/agent-feed-wire";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { type BotMachine } from "@/features/bots/botMachines";
import { BotDirectoryColumn } from "@/features/bots/dialogs/BotDirectoryColumn";
import { useMachineInventory } from "@/features/bots/useMachineInventory";
import { useModal } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

/**
 * The registry's own cap on a first turn, repeated here so the dialog refuses before the round
 * trip rather than after it.
 */
const MAXIMUM_FIRST_TURN = 32_768;

/** The folder list alone. Which sessions are in one is the session picker's question, not this. */
const NO_PATHS: readonly string[] = [];

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
  machines,
  botMachines,
  inventoryLoading,
  onClose,
  onCreate,
}: {
  open: boolean;
  /** This machine's directories, already on the app's inventory stream. */
  projects: ProjectSummary[];
  bots: BotView[];
  /** Every sidecar a Bot can be created on, home first. One machine hides the picker entirely. */
  machines: readonly BotMachine[];
  /** Which machine each Bot is on, as of this render: the claimed directories are decided in it. */
  botMachines: ReadonlyMap<string, BotMachine>;
  inventoryLoading: boolean;
  onClose: () => void;
  /**
   * Creates the Bot on the machine its directory is on.
   *
   * The machine is passed rather than inferred from the path, because a path is not an address: two
   * peers can both have `/home/ubuntu/projects/x` and only one of them is the one the reader picked.
   */
  onCreate: (command: Omit<AddBotCommand, "requestId">, machine: BotMachine) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  // Home first, which is what `mergeMachineBots` and the session picker both order by, so the
  // default is the machine the panel is running beside and picking another is a deliberate act.
  // At least one machine always exists -- the app names this one when its embedder names none --
  // so an empty list is a caller that is wrong rather than a state to render around.
  const [machine, setMachine] = useStateFor<BotMachine>(open, () => machines[0]!);
  const [selectedPath, setSelectedPath] = useStateFor<string | null>(open, () => null);
  const [name, setName] = useStateFor(open, () => "");
  const [iconUrl, setIconUrl] = useStateFor(open, () => "");
  const [role, setRole] = useStateFor(open, () => "");
  const [description, setDescription] = useStateFor(open, () => "");
  const [labels, setLabels] = useStateFor(open, () => "");
  const [customMetadata, setCustomMetadata] = useStateFor(open, () => "");
  const [canAddBots, setCanAddBots] = useStateFor(open, () => false);
  // On by default: a Bot is a directory and the sessions working in it, and creating one almost
  // always means starting the first. Turning it off is how an existing session's directory gets
  // adopted without spawning a second agent into it.
  const [startSession, setStartSession] = useStateFor(open, () => true);
  const [firstTurn, setFirstTurn] = useStateFor(open, () => "");
  const [pending, setPending] = useStateFor(open, () => false);
  const [error, setError] = useStateFor<string | null>(open, () => null);

  // Only while a PEER is selected. This machine's directories are already on the app's stream, and
  // opening a second one for them would spend a stream slot to learn what the panel already knows.
  const peerProjects = useMachineInventory(machine.id === undefined ? null : machine, NO_PATHS);
  const machineProjects = machine.id === undefined ? projects : peerProjects.projects;
  const machineProjectsLoading = machine.id === undefined ? inventoryLoading : peerProjects.loading;

  // Scoped to the selected machine, because a claim is a claim on THAT machine's directory. Two
  // Linux peers both have `/home/ubuntu`, and a Bot on one of them must not grey the other out.
  const claimedDirectories = useMemo(
    () =>
      new Set(bots.filter((bot) => botMachines.get(bot.botId)?.id === machine.id).map((bot) => bot.environment.path)),
    [bots, botMachines, machine.id],
  );

  // Memoized on the machine, not rebuilt per render: the picker re-reads the folder it is
  // showing whenever this identity changes, and a fresh closure every render would make that a
  // request loop for as long as the picker is open.
  const browse = useCallback((path: string | null) => machine.feed.browseDirectories(path), [machine]);
  // Memoized for the same reason, and on the same machine: a folder a reader makes while naming a
  // Bot has to land on the machine they picked, or the Bot is pointed at a path that is not there.
  const createFolder = useCallback((path: string, name: string) => machine.feed.createDirectory(path, name), [machine]);

  useModal(dialogRef, Boolean(open), { attributeFallback: true });

  useDomSync(() => {
    if (selectedPath) globalThis.requestAnimationFrame?.(() => nameInput.current?.focus());
  }, [selectedPath]);

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
        setError(`${file.name} is longer than ${MAXIMUM_FIRST_TURN} characters`);
        return;
      }
      setFirstTurn(text);
      setError(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!selectedPath || pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onCreate(
        {
          name: name.trim(),
          ...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}),
          directoryPath: selectedPath,
          metadata: {
            ...(role.trim() ? { role: role.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
            labels: labels
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean),
            custom: metadataLines(customMetadata),
          },
          grants: canAddBots ? ["add_bot"] : [],
          // The title is left to the sidecar, which defaults it to the Bot's name. Two places
          // deciding what a session is called is how the canvas and `ListAgents` end up disagreeing.
          ...(startSession ? { launch: firstTurn.trim() ? { prompt: firstTurn } : {} } : {}),
        },
        machine,
      );
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
            <h2 id="bot-creator-title" className="text-base font-semibold">
              Add Bot
            </h2>
            <p className="text-xs text-muted-foreground">
              Name a Bot, bind its project directory, and start the session that works in it.
            </p>
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
          <BotDirectoryColumn
            machines={machines}
            machine={machine}
            onMachine={(next) => {
              setMachine(next);
              // A directory belongs to one machine, so a selection cannot survive the move:
              // keeping it would submit this machine's path to that one.
              setSelectedPath(null);
              setError(null);
            }}
            projects={machineProjects}
            loading={machineProjectsLoading}
            error={peerProjects.error}
            claimed={claimedDirectories}
            selectedPath={selectedPath}
            onSelect={(path) => {
              setSelectedPath(path);
              setError(null);
            }}
            browse={browse}
            createFolder={createFolder}
          />

          <div className="min-h-0 overflow-y-auto p-4">
            {!selectedPath ? (
              <div className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
                Choose the directory this Bot represents.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
                  <BotAvatar bot={{ name: name || "New Bot", ...(iconUrl ? { iconUrl } : {}) }} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{name || "New Bot"}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{selectedPath}</p>
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
                      <span className="block text-xs text-muted-foreground">
                        Runs in its own tmux pane, named after the Bot, and appears on the canvas.
                      </span>
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
                    <span className="block text-xs text-muted-foreground">
                      The tool becomes available to an attached Pi session when its runtime opens.
                    </span>
                  </span>
                </label>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
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
              disabled={!selectedPath || !name.trim() || pending}
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
