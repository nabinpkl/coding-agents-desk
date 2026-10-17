// One run, read side by side: what was asked, then one lane per contestant -- its head on top,
// and under it its session or its diff -- or the matrix of files every contestant touched.
//
// The lanes are the content, so the frame around them is one band, in three steps of weight: the
// prompt (what every lane was asked) at full ink, then a caption line of what the run is and where
// it stands, then the box the next prompt is typed into, quiet until it holds something to send.
// The switch between sessions, files and diffs and the run's own actions share the prompt's line,
// at its end, rather than a row of their own.
//
// A lane is one contestant from top to bottom. Its head sits directly over its own session, so a
// reader never matches a number in one table to a transcript in another. The lanes share one
// horizontal scroll, so on a narrow screen they move together and stay aligned.
//
// The switch stays put: the header holds nothing that changes with the view, so a reader flicking
// between views of one run never has it move out from under the finger.
//
// A run with a judge has its switch beside Remove; the judge's window floats over the lanes' corner
// only while it is open (`judge/ArenaJudgeWindow.tsx`).
//
// A terminals run whose lanes were opened before its prompt has no prompt to show yet, so the
// header holds the box the prompt is typed into instead. It goes to every lane at once, as soon as
// all of them are ready -- sending it early is fine, it waits at the same line.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, LoaderCircle, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";
import type { ArenaRunDetail, ArenaRunSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { DiffLane } from "@/features/arena/ArenaDiffs";
import { ArenaFilesMatrix } from "@/features/arena/ArenaFilesMatrix";
import { ArenaLaneFacts } from "@/features/arena/ArenaLaneFacts";
import { SessionLane, useRunSessions } from "@/features/arena/ArenaSessionLanes";
import { ArenaJudgeWindow, JudgeSwitch } from "@/features/arena/judge/ArenaJudgeWindow";
import { lineupKind } from "@/features/arena/ArenaNewRun";
import { basename, diffStat, elapsedMs, fileMatrix, formatAgo } from "@/features/arena/arenaFacts";
import { FIELD, FOCUS, ICON_BUTTON, isLive, PRIMARY_BUTTON, TEXT } from "@/features/arena/arenaVocabulary";

export type ArenaView = "sessions" | "files" | "diffs";

export function ArenaRunView({
  run,
  detail,
  view,
  onView,
  now,
  feed,
  context,
  deleting,
  problem,
  railOpen,
  onToggleRail,
  onDelete,
  onSendPrompt,
}: {
  run: ArenaRunSummary;
  /** The facts, which arrive on their own request; null until they have. */
  detail: ArenaRunDetail | null;
  view: ArenaView;
  onView: (view: ArenaView) => void;
  now: number;
  feed: SidecarDataSource;
  context: SessionViewContext;
  deleting: boolean;
  problem: string | null;
  /** Whether the list of runs is beside this one; the header holds its switch. */
  railOpen: boolean;
  onToggleRail: () => void;
  onDelete: () => void;
  /** Gives a run whose lanes are open its prompt; answers the sidecar's refusal, or null. */
  onSendPrompt: (prompt: string) => Promise<string | null>;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const live = run.contestants.some(isLive);
  const awaitingPrompt = run.mode === "terminals" && run.prompt === "";
  const ready = run.contestants.filter((c) => c.status === "ready").length;
  const settled = run.contestants.filter((c) => c.status === "closed" || c.status === "failed").length;
  const contestants = detail?.contestants ?? [];
  const fileCount = fileMatrix(contestants).filter((row) => row.inRepository).length;
  const changed = contestants.filter((c) => diffStat(c.gitDiff).files > 0).length;
  const long = run.prompt.length > 160 || run.prompt.split("\n").length > 2;
  const slowestMs = Math.max(1, ...contestants.map((c) => elapsedMs(c, now) ?? 0));
  const directories = [run.repoPath, ...run.contestants.map((c) => c.worktreePath), ...(run.judge ? [run.judge.folder] : [])];
  const { sessions, error: catalogError } = useRunSessions(feed, directories);
  const controlsHosts = useControlsHosts();
  // Where the run works is worth a word only when the reader chose it: a repository the arena
  // made, at its HEAD, is every run's default and says nothing.
  const where = run.repoCreated && run.baseRef === "HEAD" ? null : `${run.repoCreated ? "own repository" : basename(run.repoPath)} @ ${run.baseRef}`;

  const views: { name: ArenaView; label: string; count: number | null }[] = [
    { name: "sessions", label: "Sessions", count: null },
    { name: "files", label: "Files", count: fileCount },
    { name: "diffs", label: "Diffs", count: changed },
  ];

  return (
    // The sessions view is exactly the column's height, so its lanes take what the header leaves
    // and each composer sits on screen with the feed above it absorbing the difference; below a
    // height where a lane would be too short to work in, the column scrolls instead.
    <article
      aria-label="Arena run"
      className={`flex flex-col ${view === "sessions" ? "h-full min-h-[32rem]" : "min-h-full"}`}
    >
      <header
        className={`flex shrink-0 flex-col gap-3 border-b border-border bg-background px-4 py-3 ${view === "sessions" ? "" : "sticky top-0 z-20"}`}
      >
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={onToggleRail}
            aria-expanded={railOpen}
            aria-controls="arena-runs"
            aria-label={railOpen ? "Hide the runs" : "Show the runs"}
            title={railOpen ? "Hide the runs" : "Show the runs"}
            className={`${ICON_BUTTON} -ml-1.5`}
          >
            {railOpen ? <PanelLeftClose aria-hidden className="size-4" /> : <PanelLeftOpen aria-hidden className="size-4" />}
          </button>
          <div className="min-w-[min(100%,16rem)] flex-1 pt-1.5">
            {awaitingPrompt ? (
              <h2 className={`${TEXT.title} font-semibold text-foreground`}>{run.name}</h2>
            ) : (
              <h2
                className={`max-w-[80ch] whitespace-pre-wrap break-words text-pretty ${TEXT.title} leading-snug font-semibold text-foreground ${long && !promptOpen ? "line-clamp-2" : ""}`}
              >
                {run.round > 1 ? (
                  <span className={`mr-2 ${TEXT.meta} font-medium text-muted-foreground`}>Prompt {run.round}</span>
                ) : null}
                {run.prompt}
              </h2>
            )}
            {long && !awaitingPrompt ? (
              <button
                type="button"
                onClick={() => setPromptOpen((open) => !open)}
                aria-expanded={promptOpen}
                className={`rounded ${TEXT.meta} text-muted-foreground underline-offset-2 hover:text-foreground hover:underline ${FOCUS}`}
              >
                {promptOpen ? "Show less" : "Show the whole prompt"}
              </button>
            ) : null}
            <p className={`mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 ${TEXT.meta} text-muted-foreground`}>
              {awaitingPrompt ? null : (
                <>
                  <span className="text-foreground">{run.name}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{lineupKind(run.contestants.map((c) => c.source))}</span>
              {where ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="font-mono" title={run.repoPath}>{where}</span>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span>{formatAgo(run.createdAt, now)}</span>
              <span aria-hidden>·</span>
              <span className={live ? "text-arena-running" : ""}>
                {awaitingPrompt
                  ? `${ready} of ${run.contestants.length} ready`
                  : live ? `${settled} of ${run.contestants.length} settled` : "ready for the next prompt"}
              </span>
            </p>
          </div>
          {/* Wraps on the narrowest phones, where the switch and the run's actions are wider than
              the screen: the actions drop under the switch, which stays where it was. */}
          <div className="flex flex-wrap items-center gap-1">
            <div role="tablist" aria-label="Compare by" className="mr-1 inline-flex rounded-lg bg-muted p-0.5">
              {views.map((one) => (
                <button
                  key={one.name}
                  type="button"
                  role="tab"
                  aria-selected={view === one.name}
                  onClick={() => onView(one.name)}
                  className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 ${TEXT.meta} font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm ${FOCUS}`}
                >
                  {one.label}
                  {one.count !== null && detail ? <span className="tabular-nums">{one.count}</span> : null}
                </button>
              ))}
            </div>
            {run.judge ? <JudgeSwitch judge={run.judge} open={judgeOpen} onToggle={() => setJudgeOpen((open) => !open)} /> : null}
            <button
              type="button"
              aria-label="Remove run"
              title={
                awaitingPrompt
                  ? "Close the lanes and remove the run"
                  : live ? "A run cannot be removed while it is dueling" : "Remove run and its worktrees"
              }
              onClick={onDelete}
              disabled={deleting || (live && !awaitingPrompt)}
              className={`${ICON_BUTTON} hover:text-destructive`}
            >
              <Trash2 aria-hidden className="size-4" />
            </button>
          </div>
        </div>
        {/* A run never ends: once its lanes settle, the next prompt goes to every one of them, in
            the session each already has. */}
        <LanesPrompt onSend={onSendPrompt} next={!awaitingPrompt} busy={live && !awaitingPrompt} />
        {problem ? (
          <p role="alert" className={`${TEXT.meta} text-destructive`}>{problem}</p>
        ) : null}
      </header>

      <div role="tabpanel" aria-label={views.find((one) => one.name === view)?.label} className="flex min-h-0 flex-1 flex-col">
        {!detail ? (
          <p className={`px-4 py-6 ${TEXT.meta} text-muted-foreground`}>Reading the facts.</p>
        ) : (
          <>
            {catalogError && view === "sessions" ? (
              <p role="alert" className={`px-4 py-2 ${TEXT.meta} text-destructive`}>
                The session catalog did not answer: {catalogError}
              </p>
            ) : null}
            <LaneGrid lanes={contestants.length} tall={view === "sessions"}>
              {contestants.map((contestant) => (
                <ArenaLaneFacts
                  key={`facts-${contestant.contestantId}`}
                  contestant={contestant}
                  slowestMs={slowestMs}
                  now={now}
                  controlsRef={view === "sessions" ? controlsHosts.refFor(contestant.contestantId) : undefined}
                />
              ))}
              {view === "sessions"
                ? contestants.map((contestant) => (
                    <SessionLane
                      key={`session-${contestant.contestantId}`}
                      contestant={contestant}
                      listed={contestant.sessionId ? sessions.get(contestant.sessionId) ?? null : null}
                      context={context}
                      controlsHost={controlsHosts.hosts[contestant.contestantId] ?? null}
                    />
                  ))
                : view === "diffs"
                  ? contestants.map((contestant) => (
                      <DiffLane key={`diff-${contestant.contestantId}`} contestant={contestant} />
                    ))
                  : null}
            </LaneGrid>
            {view === "files" ? <ArenaFilesMatrix contestants={contestants} /> : null}
          </>
        )}
      </div>
      {run.judge && judgeOpen ? (
        <ArenaJudgeWindow
          judge={run.judge}
          listed={run.judge.sessionId ? sessions.get(run.judge.sessionId) ?? null : null}
          context={context}
          onClose={() => setJudgeOpen(false)}
        />
      ) : null}
    </article>
  );
}

/**
 * Each lane head's slot for its session's controls, by contestant. The refs are made once per
 * contestant: a fresh callback each render would be called with null and then the element again,
 * and each call is a state change.
 */
function useControlsHosts(): {
  hosts: Readonly<Record<string, HTMLElement | null>>;
  refFor: (contestantId: string) => (host: HTMLElement | null) => void;
} {
  const [hosts, setHosts] = useState<Record<string, HTMLElement | null>>({});
  const refs = useRef(new Map<string, (host: HTMLElement | null) => void>());
  const refFor = (contestantId: string) => {
    let ref = refs.current.get(contestantId);
    if (!ref) {
      ref = (host) => setHosts((previous) => (previous[contestantId] === host ? previous : { ...previous, [contestantId]: host }));
      refs.current.set(contestantId, ref);
    }
    return ref;
  };
  return { hosts, refFor };
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SEND_CHORD = MAC ? "⌘↵" : "Ctrl↵";

/**
 * A prompt for every lane: the first, typed once the lanes are open, or the next, once the last
 * one has settled in every lane.
 *
 * The first is the view's one action, so it is a full box with a filled button. The next shares
 * the header with the lanes the reader is watching, so it is one quiet row that grows with what is
 * typed, its send button inside it the way every session composer has one, filled only once there
 * is something to send. It can be drafted while the lanes work, and sent once they settle.
 */
function LanesPrompt({
  onSend,
  next,
  busy,
}: {
  onSend: (prompt: string) => Promise<string | null>;
  /** The prompt after the first: one row, and cleared once sent. */
  next: boolean;
  /** The lanes are still on the last prompt, so this one waits. */
  busy: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const canSend = !sending && !busy && text.trim().length > 0;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setRefusal(null);
    const problem = await onSend(text);
    setSending(false);
    if (problem) setRefusal(problem);
    else if (next) setText("");
  };
  const sendOnChord = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
  const refusalLine = refusal ? <p role="alert" className={`${TEXT.meta} text-destructive`}>{refusal}</p> : null;
  if (next) {
    return (
      <div className="flex max-w-3xl flex-col gap-1.5">
        {/* The border is the row's, around the field and its button side by side, the way a
            session composer draws one: the button sits in the box without lying over the text. */}
        <div
          className="flex items-end gap-2 rounded-md border border-input bg-background py-1.5 pr-1.5 pl-3 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50"
        >
          <textarea
            aria-label="Next prompt for every lane"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnChord}
            placeholder={busy ? "Draft the next prompt; it sends once every lane settles" : "Next prompt for every lane"}
            rows={1}
            className={`block max-h-40 min-h-7 flex-1 resize-none bg-transparent py-0.5 ${TEXT.body} leading-relaxed text-foreground outline-none field-sizing-content placeholder:text-muted-foreground`}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Send to every lane"
            title={busy ? "The lanes are still on the last prompt; send this once they settle" : `Send to every lane (${SEND_CHORD})`}
            className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors duration-150 hover:bg-primary/90 active:bg-primary/80 disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground ${FOCUS}`}
          >
            {sending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden className="size-4" />}
          </button>
        </div>
        {refusalLine}
      </div>
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <label htmlFor={id} className={`${TEXT.meta} font-medium text-muted-foreground`}>
        Prompt
      </label>
      <textarea
        id={id}
        aria-label="Prompt every lane gets"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={sendOnChord}
        placeholder="The one prompt every lane gets"
        rows={3}
        autoFocus
        className={`${FIELD} min-h-20 resize-y leading-relaxed`}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {refusal ? <p role="alert" className={`mr-auto ${TEXT.meta} text-destructive`}>{refusal}</p> : null}
        <button type="button" onClick={() => void send()} disabled={!canSend} className={`${PRIMARY_BUTTON} whitespace-nowrap`}>
          {sending ? "Sending" : "Send to every lane"}
          <kbd className="rounded border border-primary-foreground/30 px-1 font-sans text-[11px] leading-4 opacity-80">
            {SEND_CHORD}
          </kbd>
        </button>
      </div>
    </div>
  );
}

/**
 * The lanes' shared grid: one column per contestant, its facts in the first row and the chosen
 * view in the second, scrolled sideways together. When the lanes are wider than the screen, the
 * edge they continue past fades, since an overlay scrollbar shows nothing until it is used.
 */
function LaneGrid({ lanes, tall, children }: { lanes: number; tall: boolean; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => {
      setEdges({
        left: node.scrollLeft > 1,
        right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      });
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [lanes]);
  return (
    <div className={`relative ${tall ? "min-h-0 flex-1" : ""}`}>
      <div ref={scroller} className={`overflow-x-auto ${tall ? "h-full" : ""}`}>
        <div
          className={`grid min-w-full gap-x-px bg-border ${tall ? "h-full" : ""}`}
          style={{
            gridTemplateColumns: `repeat(${lanes}, minmax(min(22rem, 86vw), 1fr))`,
            // A session lane is a whole session -- transcript and composer -- and gets all the
            // height under the facts, whatever the header above took.
            gridTemplateRows: tall ? "auto minmax(0, 1fr)" : "auto auto",
          }}
        >
          {children}
        </div>
      </div>
      {edges.left ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent" />
      ) : null}
      {edges.right ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />
      ) : null}
    </div>
  );
}
