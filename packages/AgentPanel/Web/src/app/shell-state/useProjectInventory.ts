// The project and session inventory, and the one stream it all arrives on.
//
// One subscription for the whole sidebar, reopened when the set of watched projects changes and
// left alone otherwise. Everything about that stream is here: what it fills, what it says while
// it is failing, and the backoff that keeps asking -- because a one-shot subscription that is
// never retried is how a panel sits on "agent feed is not ready" for a whole session.
//
// Which projects are watched is decided outside: a Bot session picker and a just-started session
// both add one, and neither is the inventory's business.

import { useCallback, useMemo, useRef, useState } from "react";
import type { ProjectSummary, RecentSessionsPayload, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useTimeout } from "@/hooks/useInterval";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

/**
 * How long to wait before re-subscribing after a failure.
 *
 * Doubling from a second, capped, because the two failures worth surviving have
 * very different shapes: a sidecar restart is back within seconds, while a
 * sidecar that cannot start at all should not be asked once a second forever.
 * Each attempt already costs the host's own readiness wait, so this is the pause
 * on top of that, not the whole cadence.
 */
function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000);
}

/** How many of the most recently changed sessions the flat list asks for at a time. */
export const RECENT_SESSIONS_PAGE = 30;

/**
 * How long typing has to pause before a title search reopens the stream. Each change of the query
 * is a new stream, so one per keystroke would open and drop a connection per letter.
 */
export const SESSION_SEARCH_PAUSE_MS = 300;

export function useProjectInventory(
  feed: SidecarDataSource,
  /** Directories to watch beyond the expanded ones; see the caller for what adds one. */
  extraProjectPaths: readonly string[],
  /** The project the last selection was in, expanded first so the restore has rows to match. */
  rememberedProjectPath: string | undefined,
  /**
   * Whether a flat, most-recently-changed list is showing. While it is, the stream carries that
   * list instead of the expanded projects' lists: nothing on screen reads those, and the sidecar
   * orders the flat one, so the panel neither holds every project's sessions nor sorts them.
   */
  recentWanted = false,
  /**
   * Whether the Sessions view a title search belongs to is on screen, grouped or not. A search
   * typed there is answered by the flat list even while the view is grouped, because the grouped
   * view holds only the projects that are expanded, and a search is for finding the rest.
   */
  searchable = false,
) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Every expanded project's sessions, owned here because they arrive on the same
  // stream as the project list. The sidebar renders what is in here; it subscribes to
  // nothing.
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionSummary[]>>(new Map());
  // Each expanded project's archived sessions, kept apart so nothing that lists sessions can show
  // one by accident. Only the project list's Archived toggle reads it.
  const [archivedByProject, setArchivedByProject] = useState<Map<string, SessionSummary[]>>(new Map());
  // Archived project folders, kept apart for the same reason. Only the project list's Archived
  // projects fold reads it.
  const [archivedProjects, setArchivedProjects] = useState<ProjectSummary[]>([]);
  const [loadingLayer, setLoadingLayer] = useState(true);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<Set<string>>(new Set());
  const [recentLimit, setRecentLimit] = useState(RECENT_SESSIONS_PAGE);
  const [recent, setRecent] = useState<RecentSessionsPayload | null>(null);
  // The title search: what the field shows, and what the stream was last asked for once typing
  // paused. Clearing the field applies at once, since there is nothing to wait for.
  const [recentQuery, setRecentQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const typedQuery = recentQuery.trim();
  useTimeout(() => setSettledQuery(typedQuery), typedQuery === "" ? null : SESSION_SEARCH_PAUSE_MS, typedQuery);
  if (typedQuery === "" && settledQuery !== "") setSettledQuery("");
  const searching = searchable && settledQuery !== "";
  const recentCount = recentWanted || searching ? recentLimit : undefined;
  // How many held-out security reviews the flat list asks for: none while their row is folded,
  // because a folded row draws only the count the stream sends anyway.
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [reviewLimit, setReviewLimit] = useState(RECENT_SESSIONS_PAGE);
  const reviewCount = reviewsOpen ? reviewLimit : 0;
  // The subscription's identity, not merely its argument: expanding or collapsing a
  // project reopens the inventory stream exactly once, and re-rendering for any other
  // reason leaves the open stream alone. Joined on NUL, the one byte a POSIX path
  // cannot contain, so the round trip cannot invent or lose a path.
  const subscribedProjectKey = useMemo(
    () => [...new Set([...(recentWanted ? [] : expandedProjectPaths), ...extraProjectPaths])].sort().join("\0"),
    [expandedProjectPaths, extraProjectPaths, recentWanted],
  );
  const subscribedProjectPaths = useMemo(
    () => (subscribedProjectKey === "" ? [] : subscribedProjectKey.split("\0")),
    [subscribedProjectKey],
  );
  const [initializedProjectExpansion, setInitializedProjectExpansion] = useState(false);
  // Incremented to re-run the subscription below after a failure.
  //
  // A visibility subscription is one-shot: the host tears the stream down when it
  // reports an error, so without this the first failure was permanent. That is how
  // a restored Agents window that came up one second before its sidecar sat on
  // "agent feed is not ready" for a whole session. The host now waits for a
  // sidecar that is starting, which covers the launch race; this covers what is
  // left -- an outage longer than that wait, or a sidecar that dies and restarts
  // while the window is open.
  //
  // Only ever increments. The consecutive-failure count that sets the delay lives
  // in a ref instead, because resetting it on success would be a state change in
  // the subscription's own key -- which tears down the subscription that just
  // succeeded and re-subscribes, leaving the viewer back on "Loading".
  const [retryNonce, setRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  // The stream dropped after it had delivered, and what it delivered is still on screen. A sidecar
  // restart drops it every time, and the list used to be swapped for "unavailable" and then
  // "Loading" and then redrawn, for a stream that was back within seconds; now the list stays and
  // this says it is not following. An error is for a stream that never delivered at all.
  const [reconnecting, setReconnecting] = useState(false);
  const consecutiveFailures = useRef(0);
  // Whether this surface has ever been handed an inventory, which is what tells a
  // reopened stream apart from a first one. Kept through a failure, so the retry after
  // one reopens behind the list it already has rather than behind "Loading".
  const deliveredInventory = useRef(false);

  useSubscription(
    `${sourceKey(feed)}:${retryNonce}:${recentCount}:${reviewCount}:${searching ? settledQuery : ""}:${subscribedProjectPaths.join("\u0000")}`,
    () => {
      // Not on every resubscribe: expanding a project reopens this stream, and a sidebar
      // that flipped back to "Loading projects" each time a row was unfolded would be
      // reporting the transport's business as the reader's.
      if (!deliveredInventory.current) setLoadingLayer(true);
      // Dropped when the flat list goes away, so turning it back on shows loading rather than a cut
      // nothing has refreshed since.
      if (recentCount === undefined) setRecent(null);
      setLayerError(null);
      setRetrying(false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onError = (reason: string) => {
        if (deliveredInventory.current) setReconnecting(true);
        else setLayerError(reason);
        setLoadingLayer(false);
        setRetrying(true);
        const delay = retryDelayMs(consecutiveFailures.current);
        consecutiveFailures.current += 1;
        timer = setTimeout(() => setRetryNonce((n) => n + 1), delay);
      };
      const onLoaded = () => {
        deliveredInventory.current = true;
        setReconnecting(false);
        setLoadingLayer(false);
        setRetrying(false);
        consecutiveFailures.current = 0;
      };
      const stop = feed.subscribeInventory(
        subscribedProjectPaths,
        {
          onProjects: (snapshot, archived) => {
            setProjects(snapshot);
            setArchivedProjects(archived);
            onLoaded();
          },
          onSessions: (projectPath, sessions, archived) => {
            setSessionsByProject((current) => new Map(current).set(projectPath, sessions));
            setArchivedByProject((current) => new Map(current).set(projectPath, archived));
          },
          onRecent: setRecent,
        },
        onError,
        recentCount,
        reviewCount,
        searching ? settledQuery : "",
      );
      return () => {
        if (timer !== undefined) clearTimeout(timer);
        stop?.();
      };
    },
  );

  // Followed during render, so a project that arrives is expanded in the frame that first draws it.
  const [expandedFor, setExpandedFor] = useState(projects);
  if (expandedFor !== projects && projects.length > 0) {
    setExpandedFor(projects);
    if (!initializedProjectExpansion) {
      setInitializedProjectExpansion(true);
      // The remembered project, when it is still there, because a collapsed project's sessions
      // are not on the inventory stream at all -- so without expanding it first there is nothing
      // for the restore below to match against. Falls back to the first project, as before.
      const remembered = rememberedProjectPath;
      const openAt =
        remembered && projects.some((project) => project.projectPath === remembered)
          ? remembered
          : projects[0]!.projectPath;
      setExpandedProjectPaths(new Set([openAt]));
    } else {
      const currentPaths = new Set(projects.map((project) => project.projectPath));
      setExpandedProjectPaths((current) => {
        const next = new Set([...current].filter((path) => currentPaths.has(path)));
        return next.size === current.size ? current : next;
      });
    }
  }

  // A directory that is neither expanded nor open in a Bot session picker is no longer
  // on the stream, so keeping it would be keeping a copy that nothing refreshes.
  const [keptFor, setKeptFor] = useState(subscribedProjectPaths);
  if (keptFor !== subscribedProjectPaths) {
    setKeptFor(subscribedProjectPaths);
    const subscribed = new Set(subscribedProjectPaths);
    const keepSubscribed = (current: Map<string, SessionSummary[]>) => {
      const next = new Map([...current].filter(([projectPath]) => subscribed.has(projectPath)));
      return next.size === current.size ? current : next;
    };
    setSessionsByProject(keepSubscribed);
    setArchivedByProject(keepSubscribed);
  }

  const toggleProject = useCallback((projectPath: string) => {
    setExpandedProjectPaths((current) => {
      const next = new Set(current);
      if (next.has(projectPath)) next.delete(projectPath);
      else next.add(projectPath);
      return next;
    });
  }, []);

  const showMoreRecent = useCallback(() => setRecentLimit((count) => count + RECENT_SESSIONS_PAGE), []);
  // A new search starts at the first page: the pages a reader opened belonged to the last one.
  const changeRecentQuery = useCallback(
    (query: string) => {
      setRecentQuery(query);
      setRecentLimit(RECENT_SESSIONS_PAGE);
    },
    [setRecentQuery, setRecentLimit],
  );
  const toggleRecentReviews = useCallback(() => setReviewsOpen((open) => !open), []);
  const showMoreRecentReviews = useCallback(() => setReviewLimit((count) => count + RECENT_SESSIONS_PAGE), []);

  return {
    projects,
    sessionsByProject,
    recent,
    showMoreRecent,
    recentQuery,
    changeRecentQuery,
    /** A title search is what the flat list is showing, rather than the newest sessions. */
    searching,
    recentReviewsOpen: reviewsOpen,
    toggleRecentReviews,
    showMoreRecentReviews,
    archivedByProject,
    archivedProjects,
    loadingLayer,
    layerError,
    retrying,
    reconnecting,
    expandedProjectPaths,
    setExpandedProjectPaths,
    toggleProject,
    subscribedProjectPaths,
  };
}
