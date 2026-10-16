// Composing a run: its name, the repository it duels in, the one prompt, and the lineup of lanes.
//
// Nothing has to be filled in. A run left unnamed takes the sidecar's next "arena run N", and one
// left without a repository gets a new one of its own in the arena home, so Open lanes is a run
// from a blank form.
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
// Each lane may name the model it runs; left empty, the harness's default. An opencode lane picks
// from the serve's own list, in the same menu the composer's model switcher opens; a Claude lane
// takes an alias or a model id as typed.

import { useId, useState, type KeyboardEvent } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { OpencodeModelsHost } from "@/features/bots/dialogs/OpencodeModelsDialog";
import type { ArenaContestantSource, ArenaNewRunDefaults, ArenaRunMode } from "@agentdesk/agent-feed-wire";
import {
  FIELD,
  FOCUS,
  ICON_BUTTON,
  MAXIMUM_CONTESTANTS,
  MODE_LABEL,
  PRIMARY_BUTTON,
  SOURCE_LABEL,
  SOURCES,
  TEXT,
} from "@/features/arena/arenaVocabulary";

/** One lane as the reader drafts it. */
export interface ArenaLaneDraft {
  source: ArenaContestantSource;
  /** As typed; empty for the harness's default. */
  model: string;
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
  lineup: [{ source: "opencode", model: "" }, { source: "claude", model: "" }],
  mode: "terminals",
  manager: "claude",
};

const RUN_MODES: readonly ArenaRunMode[] = ["terminals", "headless"];
const MANAGERS: readonly (ArenaContestantSource | null)[] = ["claude", "opencode", null];

/** A lane as a reader names it: its harness, and its model when it runs one of its own. */
function laneName(lane: { source: ArenaContestantSource; model: string | null }): string {
  const model = lane.model?.trim();
  return model ? `${SOURCE_LABEL[lane.source]} ${model}` : SOURCE_LABEL[lane.source];
}

/**
 * What kind of comparison a lineup is, in the words a reader would use for it: identical lanes
 * measure variance, anything else is a bake-off between the harnesses or models it names.
 */
export function lineupKind(lineup: readonly { source: ArenaContestantSource; model: string | null }[]): string {
  if (lineup.length === 0) return "No lanes yet";
  if (lineup.length === 1) return `A single ${laneName(lineup[0]!)} run`;
  const counts = new Map<string, number>();
  for (const lane of SOURCES.flatMap((source) => lineup.filter((one) => one.source === source))) {
    counts.set(laneName(lane), (counts.get(laneName(lane)) ?? 0) + 1);
  }
  if (counts.size === 1) return `Variance · ${lineup.length} × ${[...counts.keys()][0]}`;
  return `Bake-off · ${[...counts].map(([name, count]) => `${count} ${name}`).join(" vs ")}`;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ArenaNewRun({
  feed,
  draft,
  onDraft,
  defaults,
  starting,
  problem,
  onStart,
}: {
  /** Where an opencode lane's model list is read from. */
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
  const repoId = useId();
  const modes = defaults?.modes ?? null;
  const opensLanes = draft.mode === "terminals" && draft.prompt.trim().length === 0;
  const managed = draft.mode === "terminals" && draft.manager !== null;
  // No lanes is a run whose manager adds them, which it does before the run's first prompt.
  const noLanes = draft.lineup.length === 0;
  const lanesProblem = !noLanes
    ? null
    : !managed
      ? "Add a lane, or choose a manager to plan them"
      : opensLanes ? null : "The manager adds the lanes before the prompt: leave the prompt empty";
  const canStart = !starting && lanesProblem === null && (opensLanes || draft.prompt.trim().length > 0);
  const setLineup = (lineup: ArenaLaneDraft[]) => onDraft({ ...draft, lineup });
  const setLane = (index: number, lane: Partial<ArenaLaneDraft>) =>
    setLineup(draft.lineup.map((one, at) => (at === index ? { ...one, ...lane } : one)));

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

      <div className="flex flex-wrap gap-x-4 gap-y-6">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
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
            className={FIELD}
          />
        </div>
        <div className="flex min-w-64 flex-[2] flex-col gap-2">
          <label htmlFor={repoId} className={`${TEXT.meta} font-medium text-muted-foreground`}>
            Repository
          </label>
          <input
            id={repoId}
            aria-label="Repository the contestants work in"
            value={draft.repoPath}
            onChange={(event) => onDraft({ ...draft, repoPath: event.target.value })}
            placeholder={defaults ? `New repository in ${defaults.arenaHome}` : "New repository of the run's own"}
            spellCheck={false}
            className={`${FIELD} font-mono`}
          />
        </div>
      </div>

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
        <legend className={`mb-2 ${TEXT.meta} font-medium text-muted-foreground`}>Lanes</legend>
        <div role="group" aria-label="Contestants" className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
          {draft.lineup.map(({ source, model }, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
            >
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
                    className={`min-h-8 rounded-[5px] px-2 ${TEXT.meta} font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm ${FOCUS}`}
                  >
                    {SOURCE_LABEL[option]}
                  </button>
                ))}
              </div>
              {source === "opencode" ? (
                <OpencodeLaneModel
                  feed={feed}
                  lane={index + 1}
                  model={model}
                  onModel={(next) => setLane(index, { model: next })}
                />
              ) : (
                <input
                  aria-label={`Contestant ${index + 1} model`}
                  value={model}
                  onChange={(event) => setLane(index, { model: event.target.value })}
                  placeholder="Default model"
                  title="A model alias (opus, sonnet, haiku) or id, or empty for the default"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={200}
                  className={`${MODEL_CONTROL} placeholder:text-muted-foreground focus-visible:border-ring`}
                />
              )}
            </div>
          ))}
          {draft.lineup.length < MAXIMUM_CONTESTANTS ? (
            <button
              type="button"
              aria-label="Add a contestant"
              title="Add a contestant"
              onClick={() => setLineup([...draft.lineup, draft.lineup[draft.lineup.length - 1] ?? { source: "opencode", model: "" }])}
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

/** The lane card's model control, the field and the picker's button alike. */
const MODEL_CONTROL =
  `min-h-8 w-full rounded-md border border-input bg-background px-2 py-1 font-mono ${TEXT.meta} text-foreground transition-colors ${FOCUS}`;

/**
 * An opencode lane's model: a button naming it, which opens the serve's model list under it, and
 * a clear that puts the lane back on the serve's default.
 */
function OpencodeLaneModel({ feed, lane, model, onModel }: {
  feed: SidecarDataSource;
  lane: number;
  /** As `providerID/modelID`; empty for the default. */
  model: string;
  onModel: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex items-center gap-1">
      <button
        type="button"
        aria-label={`Contestant ${lane} model`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={model || "The serve's default model"}
        onClick={() => setOpen((was) => !was)}
        className={`${MODEL_CONTROL} flex min-w-0 items-center gap-1 text-left hover:border-ring aria-expanded:border-ring`}
      >
        <span className={`min-w-0 flex-1 truncate ${model ? "" : "text-muted-foreground"}`}>{model || "Default model"}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {model ? (
        <button
          type="button"
          aria-label={`Contestant ${lane} on the default model`}
          title="Back to the default model"
          onClick={() => onModel("")}
          className={`${ICON_BUTTON} size-8`}
        >
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
      {open ? (
        <OpencodeModelsHost
          feed={feed}
          current={model || null}
          initialFilter=""
          label={`Contestant ${lane}'s model`}
          placement="below"
          onClose={() => setOpen(false)}
          onSwitch={async (providerID, modelID) => onModel(`${providerID}/${modelID}`)}
        />
      ) : null}
    </div>
  );
}
