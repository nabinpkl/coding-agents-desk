// The project and session inventory, and the one stream it all arrives on.
//
// One subscription for the whole sidebar, reopened when the set of watched projects changes and
// left alone otherwise. Everything about that stream is here: what it fills, what it says while
// it is failing, and the retry that keeps asking (`streamRetry`) -- because a one-shot
// subscription that is never retried is how a panel sits on "agent feed is not ready" for a whole
// session.
//
// Which projects are watched is decided outside: a Bot session picker and a just-started session
// both add one, and neither is the inventory's business.

import { useCallback, useMemo, useRef, useState } from "react";
import type { ProjectSummary, RecentSessionsPayload, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { streamRetry } from "@/features/activity-feed/transport/streamRetry";
import { useTimeout } from "@/hooks/useInterval";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

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
  const [retrying, setRetrying] = useState(false);
  // The stream dropped after it had delivered, and what it delivered is still on screen. A sidecar
  // restart drops it every time, and the list used to be swapped for "unavailable" and then
  // "Loading" and then redrawn, for a stream that was back within seconds; now the list stays and
  // this says it is not following. An error is for a stream that never delivered at all.
  const [reconnecting, setReconnecting] = useState(false);
  // Whether this surface has ever been handed an inventory, which is what tells a
  // reopened stream apart from a first one. Kept through a failure, so the retry after
  // one reopens behind the list it already has rather than behind "Loading".
  const deliveredInventory = useRef(false);

  // Reopened after a failure by `streamRetry`, inside the one subscription: a retry that re-ran the
  // subscription would have to be in its key, and resetting that on success tore down the stream
  // that had just come back.
  useSubscription(
    `${sourceKey(feed)}:${recentCount}:${reviewCount}:${searching ? settledQuery : ""}:${subscribedProjectPaths.join("\u0000")}`,
    () => {
      // Dropped when the flat list goes away, so turning it back on shows loading rather than a cut
      // nothing has refreshed since.
      if (recentCount === undefined) setRecent(null);
      let stop: (() => void) | undefined;
      const open = (): void => {
        // Not on every reopen: expanding a project reopens this stream, and a sidebar that flipped
        // back to "Loading projects" each time a row was unfolded would be reporting the
        // transport's business as the reader's.
        if (!deliveredInventory.current) setLoadingLayer(true);
        setLayerError(null);
        setRetrying(false);
        stop = feed.subscribeInventory(
          subscribedProjectPaths,
          {
            onProjects: (snapshot, archived) => {
              setProjects(snapshot);
              setArchivedProjects(archived);
              deliveredInventory.current = true;
              setReconnecting(false);
              setLoadingLayer(false);
              setRetrying(false);
              retry.succeeded();
            },
            onSessions: (projectPath, sessions, archived) => {
              setSessionsByProject((current) => new Map(current).set(projectPath, sessions));
              setArchivedByProject((current) => new Map(current).set(projectPath, archived));
            },
            onRecent: setRecent,
          },
          (reason) => {
            if (deliveredInventory.current) setReconnecting(true);
            else setLayerError(reason);
            setLoadingLayer(false);
            setRetrying(true);
            stop?.();
            stop = undefined;
            retry.failed();
          },
          recentCount,
          reviewCount,
          searching ? settledQuery : "",
        );
      };
      const retry = streamRetry("Sessions", open);
      open();
      return () => {
        retry.stop();
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
    /**
     * What the stream was asked for, which every other machine's Sessions list is asked for too:
     * the flat list's page (undefined while no flat list is wanted), the security reviews' page,
     * and the title search once typing paused.
     */
    asked: { recent: recentCount, reviews: reviewCount, query: searching ? settledQuery : "" },
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
