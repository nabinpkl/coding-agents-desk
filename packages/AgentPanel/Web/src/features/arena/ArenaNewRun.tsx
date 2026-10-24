// Composing a run: its name, the repository it duels in, the one prompt, and the lineup of lanes.
//
// Nothing has to be filled in. A run left unnamed takes the sidecar's next "arena run N", and one
// left on "New repository" gets one of its own in the arena home, so Open lanes is a run from a
// blank form. An existing repository is chosen with the project picker the session and Bot dialogs
// use: this machine's projects, searchable, or any folder browsed to. A plain folder in the home
// folder is made a repository by the run, its files the first commit, and its row says so; one the
// run would refuse says why and cannot be chosen (ADR-0153).
//
// The lineup is drawn as the lanes it will become -- one slot per contestant, numbered the way the
// run will number them, each with its harness chosen in place -- so what a reader builds here is
// the shape they will read afterwards. The line under it names what kind of comparison that shape
// is (one of each harness is a bake-off, several of one is a variance run), because the same
// facts mean different things in each and the reader should know which one they started.
//
// The mode says how the contestants are driven: as interactive sessions in terminals the reader
// can watch and type into, or headless. Terminals is offered only where the machine has tmux. A
// terminals run may be started with no prompt at all: that opens the lanes, each harness comes up
// in its terminal, and the prompt is typed on the run once they are ready.
//
// A terminals run may also have a manager: one more session, Claude unless the reader picks
// otherwise, that the reader can ask to plan the lanes and start them through the arena's API, to
// prompt them, or for a verdict. A run with a manager may start with no lanes at all, for it to
// add. It lives in a terminal too, so a headless run has none.
//
// Each lane may name the model it runs; left empty, the harness's default. Both pick it in the
// menu the composer's model switcher opens: an opencode lane from the serve's own list, a Claude
// lane from the CLI's aliases or a full model id typed into the menu.
//
// Each lane also takes a side. A lane for the prompt does it; a lane against it is given the same
// prompt and argues that it should not be done, editing no file (ADR-0151). For and against sets
// up the usual pair: two lanes on the first lane's harness and model, one on each side.

import { useCallback, useId, useMemo, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { inspectArenaFolders } from "@/features/arena/arenaRunsSource";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";
import type {
  ArenaContestantSource,
  ArenaLaneStance,
  ArenaNewRunDefaults,
  ArenaRunMode,
} from "@agentdesk/agent-feed-wire";
import { LaneModel } from "@/features/arena/ArenaLaneModel";
import { useMachineInventory } from "@/features/bots/useMachineInventory";
import { ProjectPicker } from "@/features/project-picker/ProjectPicker";
import {
  BUTTON,
  FIELD,
  FOCUS,
  ICON_BUTTON,
  MAXIMUM_CONTESTANTS,
  MODE_LABEL,
  PRIMARY_BUTTON,
  SEGMENT,
  SOURCE_LABEL,
  SOURCES,
  STANCE_LABEL,
  STANCES,
  TEXT,
} from "@/features/arena/arenaVocabulary";

/** One lane as the reader drafts it. */
export interface ArenaLaneDraft {
  source: ArenaContestantSource;
  /** As typed; empty for the harness's default. */
  model: string;
  stance: ArenaLaneStance;
}

export interface ArenaDraft {
  /** Empty for the sidecar's next default name. */
  name: string;
  prompt: string;
  repoPath: string;
  lineup: ArenaLaneDraft[];
  mode: ArenaRunMode;
  /** The manager's harness, or null for none; a headless run has none whatever this says. */
  manager: ArenaContestantSource | null;
}

export const EMPTY_DRAFT: ArenaDraft = {
  name: "",
  prompt: "",
  repoPath: "",
  lineup: [
    { source: "opencode", model: "", stance: "for" },
    { source: "claude", model: "", stance: "for" },
  ],
  mode: "terminals",
  manager: "claude",
};

const RUN_MODES: readonly ArenaRunMode[] = ["terminals", "headless"];
const MANAGERS: readonly (ArenaContestantSource | null)[] = ["claude", "opencode", null];

/** A lane in a lineup, as both a draft and a run's contestants carry it. */
type LineupLane = { source: ArenaContestantSource; model: string | null; stance: ArenaLaneStance };

/** A lane as a reader names it: its harness, its model when it runs one of its own, and "against". */
function laneName(lane: LineupLane): string {
  const model = lane.model?.trim();
  const named = model ? `${SOURCE_LABEL[lane.source]} ${model}` : SOURCE_LABEL[lane.source];
  return lane.stance === "against" ? `${named} against` : named;
}

/**
 * What kind of comparison a lineup is, in the words a reader would use for it: identical lanes
 * measure variance, a lineup with a lane against the prompt is for and against, and anything else
 * is a bake-off between the harnesses or models it names.
 */
export function lineupKind(lineup: readonly LineupLane[]): string {
  if (lineup.length === 0) return "No lanes yet";
  if (lineup.length === 1) return `A single ${laneName(lineup[0]!)} run`;
  const counts = new Map<string, number>();
  for (const lane of SOURCES.flatMap((source) => lineup.filter((one) => one.source === source))) {
    counts.set(laneName(lane), (counts.get(laneName(lane)) ?? 0) + 1);
  }
  if (counts.size === 1) return `Variance · ${lineup.length} × ${[...counts.keys()][0]}`;
  const kind = lineup.some((lane) => lane.stance === "against") ? "For and against" : "Bake-off";
  return `${kind} · ${[...counts].map(([name, count]) => `${count} ${name}`).join(" vs ")}`;
}

/** The project list alone: which sessions are in a project is not this picker's question. */
const NO_PATHS: readonly string[] = [];

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ArenaNewRun({
  transport,
  feed,
  draft,
  onDraft,
  defaults,
  starting,
  problem,
  onStart,
}: {
  /** Asks the sidecar what a run would make of each project. */
  transport: AgentHttpTransport;
  /** The machine the run is on: where an opencode lane's model list and the projects are read from. */
  feed: SidecarDataSource;
  draft: ArenaDraft;
  onDraft: (next: ArenaDraft) => void;
  /**
   * What a blank run gets on this machine, or null before the sidecar has said: its modes (one
   * outside them cannot be chosen), and the name and the home its folder takes.
   */
  defaults: ArenaNewRunDefaults | null;
  starting: boolean;
  problem: string | null;
  onStart: () => void;
}) {
  const nameId = useId();
  const promptId = useId();
  // The run is on the machine this tab reads, so its projects are the only ones offered.
  const machine = useMemo(() => ({ label: "this machine", feed }), [feed]);
  const inventory = useMachineInventory(machine, NO_PATHS);
  const browse = useCallback((path: string | null) => feed.browseDirectories(path), [feed]);
  const createFolder = useCallback((path: string, name: string) => feed.createDirectory(path, name), [feed]);
  // Every project, and the selection when it is a folder browsed to, asked about in one request.
  const asked = [...new Set([...inventory.projects.map((project) => project.projectPath), draft.repoPath])]
    .filter(Boolean)
    .sort();
  const folders = usePanelQuery({
    queryKey: ["arena-folders", sourceKey(transport), asked.join("\0")],
    queryFn: () => inspectArenaFolders(transport, asked),
    enabled: asked.length > 0,
  });
  const checks = new Map((folders.data ?? []).map((check) => [check.path, check]));
  const describe = (path: string) => {
    const check = checks.get(path);
    if (!check) return null;
    if (check.problem) return { note: `${check.problem[0]!.toUpperCase()}${check.problem.slice(1)}`, refused: true };
    return check.repository
      ? null
      : { note: "Not a git repository: the run makes it one, its files the first commit", refused: false };
  };
  const modes = defaults?.modes ?? null;
  const opensLanes = draft.mode === "terminals" && draft.prompt.trim().length === 0;
  const managed = draft.mode === "terminals" && draft.manager !== null;
  // No lanes is a run whose manager adds them, which it does before the run's first prompt.
  const noLanes = draft.lineup.length === 0;
  const lanesProblem = !noLanes
    ? null
    : !managed
      ? "Add a lane, or choose a manager to plan them"
      : opensLanes
        ? null
        : "The manager adds the lanes before the prompt: leave the prompt empty";
  const canStart = !starting && lanesProblem === null && (opensLanes || draft.prompt.trim().length > 0);
  const setLineup = (lineup: ArenaLaneDraft[]) => onDraft({ ...draft, lineup });
  const setLane = (index: number, lane: Partial<ArenaLaneDraft>) =>
    setLineup(draft.lineup.map((one, at) => (at === index ? { ...one, ...lane } : one)));
  // One lane does the task and one argues against it, on the same harness and model, so the two
  // differ only in which side they were told to take.
  const forAndAgainst = () => {
    const base = draft.lineup[0] ?? { source: "claude", model: "", stance: "for" };
    setLineup([
      { ...base, stance: "for" },
      { ...base, stance: "against" },
    ]);
  };

  const submitOnChord = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canStart) {
      event.preventDefault();
      onStart();
    }
  };

  return (
    <section aria-label="New run" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-6">
      <header>
        <h2 className="text-lg font-semibold">New run</h2>
      </header>

      <div className="flex flex-col gap-2">
        <label htmlFor={nameId} className={`${TEXT.meta} font-medium text-muted-foreground`}>
          Name
        </label>
        <input
          id={nameId}
          aria-label="Run name"
          value={draft.name}
          onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          placeholder={defaults?.nextName ?? "arena run"}
          maxLength={80}
          spellCheck={false}
          className={`${FIELD} max-w-md`}
        />
      </div>

      <ProjectPicker
        heading="Repository"
        machines={[machine]}
        machine={machine}
        projects={inventory.projects}
        loading={inventory.loading}
        error={inventory.error}
        selectedPath={draft.repoPath === "" ? null : draft.repoPath}
        onSelect={(repoPath) => onDraft({ ...draft, repoPath })}
        describe={describe}
        noPathOption={{
          label: "New repository",
          detail: defaults ? `Of the run's own, in ${defaults.arenaHome}` : "Of the run's own",
          onSelect: () => onDraft({ ...draft, repoPath: "" }),
        }}
        browse={browse}
        createFolder={createFolder}
        className="max-h-80 overflow-y-auto rounded-lg border border-border bg-card"
      />

      <div className="flex flex-col gap-2">
        <label htmlFor={promptId} className={`${TEXT.meta} font-medium text-muted-foreground`}>
          Prompt
        </label>
        <textarea
          id={promptId}
          aria-label="Prompt every contestant gets"
          value={draft.prompt}
          onChange={(event) => onDraft({ ...draft, prompt: event.target.value })}
          onKeyDown={submitOnChord}
          placeholder="The one prompt every contestant gets"
          rows={5}
          className={`${FIELD} min-h-32 resize-y leading-relaxed`}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={`mb-2 flex w-full items-center justify-between gap-3 ${TEXT.meta} font-medium`}>
          <span className="text-muted-foreground">Lanes</span>
          <button
            type="button"
            title="One lane does the task and one argues against it, on the first lane's harness and model"
            onClick={forAndAgainst}
            className={`${BUTTON} min-h-8 px-2.5 ${TEXT.meta}`}
          >
            For and against
          </button>
        </legend>
        <div
          role="group"
          aria-label="Contestants"
          className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2"
        >
          {draft.lineup.map(({ source, model, stance }, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className={`font-mono ${TEXT.meta} text-muted-foreground`}>c{index + 1}</span>
                {draft.lineup.length > 1 || managed ? (
                  <button
                    type="button"
                    aria-label={`Remove contestant ${index + 1}`}
                    title={`Remove contestant ${index + 1}`}
                    onClick={() => setLineup(draft.lineup.filter((_, at) => at !== index))}
                    className={`${ICON_BUTTON} size-7`}
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                ) : null}
              </div>
              <div
                role="radiogroup"
                aria-label={`Contestant ${index + 1} harness`}
                className="grid grid-cols-2 gap-0.5 rounded-md bg-muted/50 p-0.5"
              >
                {SOURCES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={source === option}
                    // A model is one harness's name for it: another harness would be handed a name it
                    // does not know, so a lane that changes harness goes back to the default.
                    onClick={() => setLane(index, option === source ? {} : { source: option, model: "" })}
                    className={SEGMENT}
                  >
                    {SOURCE_LABEL[option]}
                  </button>
                ))}
              </div>
              <div
                role="radiogroup"
                aria-label={`Contestant ${index + 1} stance`}
                className="grid grid-cols-2 gap-0.5 rounded-md bg-muted/50 p-0.5"
              >
                {STANCES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={stance === option}
                    title={
                      option === "against" ? "Argues that the prompt should not be done, and edits no file" : undefined
                    }
                    onClick={() => setLane(index, { stance: option })}
                    className={SEGMENT}
                  >
                    {STANCE_LABEL[option]}
                  </button>
                ))}
              </div>
              <LaneModel
                feed={feed}
                source={source}
                lane={index + 1}
                model={model}
                onModel={(next) => setLane(index, { model: next })}
              />
            </div>
          ))}
          {draft.lineup.length < MAXIMUM_CONTESTANTS ? (
            <button
              type="button"
              aria-label="Add a contestant"
              title="Add a contestant"
              onClick={() =>
                setLineup([
                  ...draft.lineup,
                  draft.lineup[draft.lineup.length - 1] ?? { source: "opencode", model: "", stance: "for" },
                ])
              }
              className={`flex min-h-[5.5rem] items-center justify-center gap-1.5 rounded-lg border border-dashed border-border ${TEXT.meta} text-muted-foreground transition-colors duration-150 hover:border-ring hover:bg-muted hover:text-foreground active:bg-accent ${FOCUS}`}
            >
              <Plus aria-hidden className="size-4" />
              Lane
            </button>
          ) : null}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-x-6 gap-y-6">
        <fieldset className="flex min-w-56 flex-1 flex-col gap-2">
          <legend className={`mb-2 ${TEXT.meta} font-medium text-muted-foreground`}>Run in</legend>
          <div
            role="radiogroup"
            aria-label="How the contestants are driven"
            className="grid w-full max-w-xs grid-cols-2 gap-0.5 rounded-md bg-muted/50 p-0.5"
          >
            {RUN_MODES.map((mode) => {
              const offered = modes === null || modes.includes(mode);
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={draft.mode === mode}
                  disabled={!offered}
                  title={offered ? undefined : "This machine has no tmux to run terminals in"}
                  onClick={() => onDraft({ ...draft, mode })}
                  className={`min-h-8 rounded-[5px] px-2 ${TEXT.meta} font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground ${FOCUS}`}
                >
                  {MODE_LABEL[mode]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="flex min-w-64 flex-1 flex-col gap-2">
          <legend className={`mb-2 ${TEXT.meta} font-medium text-muted-foreground`}>Manager</legend>
          <div
            role="radiogroup"
            aria-label="The run's manager"
            className="grid w-full max-w-sm grid-cols-3 gap-0.5 rounded-md bg-muted/50 p-0.5"
          >
            {MANAGERS.map((manager) => {
              const offered = draft.mode === "terminals";
              return (
                <button
                  key={manager ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={offered ? draft.manager === manager : manager === null}
                  disabled={!offered}
                  title={offered ? undefined : "A manager runs in a terminal, so a headless run has none"}
                  onClick={() => onDraft({ ...draft, manager })}
                  className={`min-h-8 rounded-[5px] px-2 ${TEXT.meta} font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground ${FOCUS}`}
                >
                  {manager ? SOURCE_LABEL[manager] : "None"}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className={`${TEXT.body} text-foreground`}>
          {lanesProblem ?? (noLanes ? "The manager plans the lanes" : lineupKind(draft.lineup))}
        </span>
        <button type="button" onClick={onStart} disabled={!canStart} className={PRIMARY_BUTTON}>
          {starting ? "Starting" : noLanes ? "Open manager" : opensLanes ? "Open lanes" : "Start run"}
          <kbd className="rounded border border-primary-foreground/30 px-1 font-sans text-[11px] leading-4 opacity-80">
            {MAC ? "⌘↵" : "Ctrl↵"}
          </kbd>
        </button>
      </div>

      {problem ? (
        <p role="alert" className={`-mt-3 ${TEXT.meta} text-destructive`}>
          {problem}
        </p>
      ) : null}
    </section>
  );
}
