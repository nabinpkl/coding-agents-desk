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
// A terminals run may also have a judge: one more session, Claude unless the reader picks
// otherwise, that the reader asks for a verdict once the lanes have something to judge. It lives
// in a terminal too, so a headless run has none.

import { useId, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
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

export interface ArenaDraft {
  /** Empty for the sidecar's next default name. */
  name: string;
  prompt: string;
  repoPath: string;
  lineup: ArenaContestantSource[];
  mode: ArenaRunMode;
  /** The judge's harness, or null for none; a headless run has none whatever this says. */
  judge: ArenaContestantSource | null;
}

export const EMPTY_DRAFT: ArenaDraft = {
  name: "",
  prompt: "",
  repoPath: "",
  lineup: ["opencode", "claude"],
  mode: "terminals",
  judge: "claude",
};

const RUN_MODES: readonly ArenaRunMode[] = ["terminals", "headless"];
const JUDGES: readonly (ArenaContestantSource | null)[] = ["claude", "opencode", null];

/** What kind of comparison a lineup is, in the words a reader would use for it. */
export function lineupKind(lineup: readonly ArenaContestantSource[]): string {
  const counts = SOURCES.map((source) => [source, lineup.filter((one) => one === source).length] as const)
    .filter(([, count]) => count > 0);
  if (lineup.length === 1) return `A single ${SOURCE_LABEL[lineup[0]!]} run`;
  if (counts.length === 1) return `Variance · ${lineup.length} × ${SOURCE_LABEL[counts[0]![0]]}`;
  return `Bake-off · ${counts.map(([source, count]) => `${count} ${SOURCE_LABEL[source]}`).join(" vs ")}`;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ArenaNewRun({
  draft,
  onDraft,
  defaults,
  starting,
  problem,
  onStart,
}: {
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
  const canStart = !starting && (opensLanes || draft.prompt.trim().length > 0);
  const setLineup = (lineup: ArenaContestantSource[]) => onDraft({ ...draft, lineup });

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
          {draft.lineup.map((source, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`font-mono ${TEXT.meta} text-muted-foreground`}>c{index + 1}</span>
                {draft.lineup.length > 1 ? (
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
                    onClick={() => setLineup(draft.lineup.map((one, at) => (at === index ? option : one)))}
                    className={`min-h-8 rounded-[5px] px-2 ${TEXT.meta} font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm ${FOCUS}`}
                  >
                    {SOURCE_LABEL[option]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {draft.lineup.length < MAXIMUM_CONTESTANTS ? (
            <button
              type="button"
              aria-label="Add a contestant"
              title="Add a contestant"
              onClick={() => setLineup([...draft.lineup, draft.lineup[draft.lineup.length - 1] ?? "opencode"])}
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
          <legend className={`mb-2 ${TEXT.meta} font-medium text-muted-foreground`}>Judge</legend>
          <div
            role="radiogroup"
            aria-label="The run's judge"
            className="grid w-full max-w-sm grid-cols-3 gap-0.5 rounded-md bg-muted/50 p-0.5"
          >
            {JUDGES.map((judge) => {
              const offered = draft.mode === "terminals";
              return (
                <button
                  key={judge ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={offered ? draft.judge === judge : judge === null}
                  disabled={!offered}
                  title={offered ? undefined : "A judge runs in a terminal, so a headless run has none"}
                  onClick={() => onDraft({ ...draft, judge })}
                  className={`min-h-8 rounded-[5px] px-2 ${TEXT.meta} font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground ${FOCUS}`}
                >
                  {judge ? SOURCE_LABEL[judge] : "None"}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className={`${TEXT.body} text-foreground`}>{lineupKind(draft.lineup)}</span>
        <button type="button" onClick={onStart} disabled={!canStart} className={PRIMARY_BUTTON}>
          {starting ? "Starting" : opensLanes ? "Open lanes" : "Start run"}
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
