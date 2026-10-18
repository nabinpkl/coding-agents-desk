// The arena tab: one prompt fanned out to contestants, read side by side.
//
// A comparison console rather than a list of tasks. The rail down the left holds the runs and the
// way into a new one; the main column holds whichever of the two the reader is on -- the composer,
// or a run laid out for comparison (its facts in one table, then its contestants' sessions, files
// or diffs in parallel lanes). Below a comfortable width the rail stacks above the column instead
// of squeezing it, because the lanes need the width more than the list does.
//
// The arena judges nothing. Every view puts the same fact for each contestant on one line and
// leaves the reading to the reader, and a contestant's session is the ordinary catalog session
// rendered by the ordinary `SessionView` -- the tab adds the grouping, the alignment and the
// facts, never a second transcript reader. A run's manager is one more such session, which the
// reader asks to plan the lanes or for a verdict; a verdict is its answer in its session, not a
// score the tab keeps.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  createArenaRun,
  deleteArenaRun,
  fetchArenaNewRunDefaults,
  fetchArenaRunDetail,
  fetchArenaRuns,
  parseRunsStreamFrame,
  sendArenaPrompt,
  STREAM_PATH,
} from "@/features/arena/arenaRunsSource";
import type { ArenaRunSummary } from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { keepTypingInSightWhileMounted } from "@/app/page/keyboardInset";
import { sidecarWindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import { ArenaNewRun, EMPTY_DRAFT, type ArenaDraft } from "@/features/arena/ArenaNewRun";
import { ArenaRunRail } from "@/features/arena/ArenaRunRail";
import { ArenaCodeButton } from "@/features/arena/code/ArenaCodeButton";
import { ArenaRunView, type ArenaView } from "@/features/arena/ArenaRunView";
import { isLive, useNow } from "@/features/arena/arenaVocabulary";
import { addressWithRun, runInAddress } from "@/features/arena/arenaAddress";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { useResizeObserver } from "@/hooks/dom/useResizeObserver";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";
import { useDomSync } from "@/hooks/dom/useDomSync";

export function ArenaSurface({
  transport,
  feed,
  host,
}: {
  transport: AgentHttpTransport;
  /** The machine's data source, which the contestants' sessions are read through. */
  feed: SidecarDataSource;
  host: HostActionsClient;
}) {
  const [runs, setRuns] = useState<ArenaRunSummary[]>([]);
  // The run on screen, or null for the new-run form. Read from the address and written back to
  // it, so a reload or a shared link opens the same run.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => runInAddress(window.location.search));
  const composing = selectedRunId === null;
  // Each run its own entry in the history, so back and forward move between runs. A removed run's
  // entry is replaced instead: going back to it would only say it is gone.
  const showRun = useCallback((runId: string | null, { replace = false } = {}) => {
    setSelectedRunId(runId);
    const next = addressWithRun(window.location.href, runId);
    if (next === window.location.href) return;
    if (replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
  }, []);
  useEventListener(window, "popstate", () => setSelectedRunId(runInAddress(window.location.search)));
  // Whether the sidecar has said which runs there are yet: until then a run named by the address
  // is not missing, only not read.
  const [runsRead, setRunsRead] = useState(false);
  const [view, setView] = useState<ArenaView>("sessions");
  // Held here rather than in the composer, so moving to a run and back keeps what was typed;
  // cleared only once the sidecar has taken it as a run.
  const [draft, setDraft] = useState<ArenaDraft>(EMPTY_DRAFT);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Null until the sidecar has said: the switch offers both modes meanwhile rather than greying
  // out one the machine may well have, and the sidecar refuses one it does not.
  // Whether the list of runs stands beside a run. Until the reader says, it does where there is
  // room beside the run, and not where it would stack above it, since there it only repeats the
  // prompt the run's header already shows. What the reader says, this browser remembers. The form
  // for a new run always has it: there is nowhere else to go from there.
  const surface = useRef<HTMLDivElement | null>(null);
  const wide = useWide(surface);
  const [railChosen, setRailChosen] = useState(readRailOpen);
  const railOpen = (railChosen ?? wide) || composing;
  const toggleRail = useCallback(() => {
    writeRailOpen(!railOpen);
    setRailChosen(!railOpen);
  }, [railOpen]);

  // The stream, from the first paint: a run that closes while the tab sits open says so without
  // the reader asking, which is the difference between a duel and a list somebody has to check.
  useSubscription(`arena-runs:${sourceKey(transport)}`, () =>
    transport.subscribe(STREAM_PATH, {
      onMessage: (payload) => {
        const frame = parseRunsStreamFrame(payload);
        if (frame) {
          setRuns(frame);
          setRunsRead(true);
        }
      },
      // A dropped stream is EventSource's to reconnect, and the one-shot fetch below re-reads
      // the list on any later remount -- so there is nothing here to say to a reader.
      onError: () => {},
    }));

  // What a run with nothing filled in gets, re-read whenever a run is made or removed (here or
  // anywhere), since the next free name moves with them. A draft still on a mode this machine
  // cannot run moves to its default, so the composer never offers a start the sidecar would refuse.
  const runIds = runs.map((run) => run.runId).join(" ");
  const defaultsRead = usePanelQuery({
    queryKey: ["arena-new-run-defaults", sourceKey(transport), runIds],
    queryFn: () => fetchArenaNewRunDefaults(transport),
    // The previous answer stands while the next free name is read, rather than the form blanking.
    placeholderData: (previous) => previous,
  });
  const defaults = defaultsRead.data ?? null;
  if (defaults && !defaults.modes.includes(draft.mode)) setDraft({ ...draft, mode: defaults.modes[0]! });

  // The one-shot fetch covers a sidecar that restarted mid-stream or a reader who reloaded. Its
  // answer seeds the list only if the stream has not already filled it.
  const listed = usePanelQuery({
    queryKey: ["arena-runs", sourceKey(transport)],
    queryFn: () => fetchArenaRuns(transport),
  });
  const [seededFrom, setSeededFrom] = useState<ArenaRunSummary[] | null>(null);
  if (listed.data && seededFrom !== listed.data) {
    const held = listed.data;
    setSeededFrom(held);
    setRuns((current) => (current.length > 0 ? current : held));
    setRunsRead(true);
  }

  // The selected run's facts, re-read whenever any of its contestants moved. The stream carries
  // status only -- files and diffs ride the detail route -- so this is where the facts arrive.
  const selected = runs.find((run) => run.runId === selectedRunId) ?? null;
  const statusKey = useMemo(
    () => JSON.stringify(selected?.contestants.map((c) => [c.contestantId, c.status, c.sessionId]) ?? null),
    [selected],
  );
  // Read again whenever a contestant's status moves, keeping the last answer for this run meanwhile.
  const detailRead = usePanelQuery({
    queryKey: ["arena-run", sourceKey(transport), selectedRunId, statusKey],
    queryFn: () => fetchArenaRunDetail(transport, selectedRunId!),
    enabled: selectedRunId !== null,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === selectedRunId ? previous : undefined),
  });
  const detail = selectedRunId ? (detailRead.data ?? null) : null;
  // A detail read for the run the reader just left is not this run's.
  const shownDetail = detail && detail.runId === selectedRunId ? detail : null;

  const anyLive = runs.some((run) =>
    run.contestants.some(isLive),
  );
  const now = useNow(anyLive);

  const start = useCallback(async () => {
    setStarting(true);
    setProblem(null);
    const answer = await createArenaRun(transport, {
      name: draft.name.trim(),
      prompt: draft.prompt,
      repoPath: draft.repoPath.trim(),
      mode: draft.mode,
      contestants: draft.lineup,
      manager: draft.mode === "terminals" ? draft.manager : null,
    });
    setStarting(false);
    if ("run" in answer) {
      // The repository and the lineup are kept: the next run is most often the same duel asked
      // a different question. A name is one run's, so it goes.
      setDraft((current) => ({ ...current, name: "", prompt: "" }));
      setRuns((current) =>
        current.some((run) => run.runId === answer.run.runId) ? current : [answer.run, ...current],
      );
      showRun(answer.run.runId);
      setView("sessions");
      return;
    }
    setProblem(answer.message);
  }, [transport, draft, showRun]);

  const sendPrompt = useCallback(async (prompt: string): Promise<string | null> => {
    if (!selectedRunId) return "no run is selected";
    const answer = await sendArenaPrompt(transport, selectedRunId, prompt);
    if ("message" in answer) return answer.message;
    setRuns((current) => current.map((run) => (run.runId === answer.run.runId ? answer.run : run)));
    return null;
  }, [transport, selectedRunId]);

  const tearDown = useCallback(async () => {
    if (!selectedRunId) return;
    setDeleting(true);
    setProblem(null);
    const answer = await deleteArenaRun(transport, selectedRunId);
    setDeleting(false);
    if ("message" in answer) {
      setProblem(answer.message);
      return;
    }
    showRun(null, { replace: true });
  }, [transport, selectedRunId, showRun]);

  // What a lane's `SessionView` needs from its surface, built from this tab's own machine. Mode
  // and cache hits are the reader's toggles across every lane at once: a comparison read raw in
  // one lane and nice in the next is not a comparison.
  const [eventMode, setEventMode] = useState<EventMode>("nice");
  const [showCacheHits, setShowCacheHits] = useState(false);
  const windowComposers = useMemo(
    () => ({
      claude: sidecarWindowComposerClient(feed, "claude"),
      codex: sidecarWindowComposerClient(feed, "codex"),
    }),
    [feed],
  );
  const context = useMemo<SessionViewContext>(
    () => ({
      feed,
      host,
      eventMode,
      onToggleEventMode: () => setEventMode((mode) => (mode === "nice" ? "raw" : "nice")),
      showCacheHits,
      onToggleCacheHits: () => setShowCacheHits((shown) => !shown),
      windowComposers,
      // A lane is a narrow column: its tasks panel presents as a sheet over it.
      compact: true,
      tasksHost: null,
    }),
    [feed, host, eventMode, showCacheHits, windowComposers],
  );

  const selectRun = useCallback((runId: string) => {
    showRun(runId);
    setProblem(null);
  }, [showRun]);

  // A lane's composer sits at the foot of a column taller than a phone with its keyboard up, so
  // shortening the page does not lift it: the column has to scroll to it.


  return (
    <div ref={surface} data-arena-surface className="@container flex h-full min-h-0 bg-background text-foreground">
      <div className="flex min-h-0 w-full flex-col @3xl:flex-row">
        {/* Stacked above the run, the rail steps aside while a keyboard is up: what is left of a
            phone's screen goes to the field being typed into. */}
        <aside
          id="arena-runs"
          className={`${railOpen ? "flex" : "hidden"} max-h-56 shrink-0 flex-col border-b border-border @max-3xl:[html[data-keyboard-up]_&]:hidden @3xl:max-h-none @3xl:w-64 @3xl:border-r @3xl:border-b-0`}
        >
          <ArenaRunRail
            runs={runs}
            selectedRunId={selectedRunId}
            composing={composing}
            now={now}
            browse={defaults ? (
              <ArenaCodeButton
                transport={transport}
                place={{}}
                label="Browse the arena folder"
                title="Arena"
                path={defaults.arenaHome}
              />
            ) : null}
            onSelect={selectRun}
            onCompose={() => {
              showRun(null);
              setProblem(null);
            }}
          />
        </aside>
        <main ref={keepTypingInSightWhileMounted} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selectedRunId === null ? (
            <ArenaNewRun
              feed={feed}
              draft={draft}
              onDraft={setDraft}
              defaults={defaults}
              starting={starting}
              problem={problem}
              onStart={() => void start()}
            />
          ) : selected ? (
            <ArenaRunView
              key={selected.runId}
              run={selected}
              detail={shownDetail}
              transport={transport}
              view={view}
              onView={setView}
              now={now}
              feed={feed}
              context={context}
              deleting={deleting}
              problem={problem}
              railOpen={railOpen}
              onToggleRail={toggleRail}
              onDelete={() => void tearDown()}
              onSendPrompt={sendPrompt}
            />
          ) : runsRead ? (
            <p className="px-5 py-8 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
              That run is no longer listed.
            </p>
          ) : null}
        </main>
      </div>
    </div>
  );
}

const RAIL_KEY = "agentdesk.arena.railOpen";

/** What this browser was told, or null if nothing; storage that throws (a private window) is null. */
function readRailOpen(): boolean | null {
  try {
    const held = window.localStorage.getItem(RAIL_KEY);
    return held === null ? null : held === "true";
  } catch {
    return null;
  }
}

function writeRailOpen(open: boolean): void {
  try {
    window.localStorage.setItem(RAIL_KEY, String(open));
  } catch {
    // Remembering is a convenience; the rail still opens and closes for this visit.
  }
}

/** Whether the surface is at least `@3xl` wide, where the rail stands beside the run. */
function useWide(surface: React.RefObject<HTMLDivElement | null>): boolean {
  const [wide, setWide] = useState(true);
  const measure = (node: Element) => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setWide(node.clientWidth >= 48 * rem);
  };
  // Once before the first paint, so a narrow surface never draws a frame laid out wide.
  useDomSync(() => {
    if (surface.current) measure(surface.current);
  }, [surface]);
  useResizeObserver(surface, () => {
    if (surface.current) measure(surface.current);
  });
  return wide;
}
