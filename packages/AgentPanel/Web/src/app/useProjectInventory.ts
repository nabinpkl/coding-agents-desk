// The project and session inventory, and the one stream it all arrives on.
//
// One subscription for the whole sidebar, reopened when the set of watched projects changes and
// left alone otherwise. Everything about that stream is here: what it fills, what it says while
// it is failing, and the backoff that keeps asking -- because a one-shot subscription that is
// never retried is how a panel sits on "agent feed is not ready" for a whole session.
//
// Which projects are watched is decided outside: a Bot session picker and a just-started session
// both add one, and neither is the inventory's business.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

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

export function useProjectInventory(
  feed: SidecarDataSource,
  /** Directories to watch beyond the expanded ones; see the caller for what adds one. */
  extraProjectPaths: readonly string[],
  /** The project the last selection was in, expanded first so the restore has rows to match. */
  rememberedProjectPath: string | undefined,
) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Every expanded project's sessions, owned here because they arrive on the same
  // stream as the project list. The sidebar renders what is in here; it subscribes to
  // nothing.
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionSummary[]>>(
    new Map(),
  );
  const [loadingLayer, setLoadingLayer] = useState(true);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<Set<string>>(new Set());
  // The subscription's identity, not merely its argument: expanding or collapsing a
  // project reopens the inventory stream exactly once, and re-rendering for any other
  // reason leaves the open stream alone. Joined on NUL, the one byte a POSIX path
  // cannot contain, so the round trip cannot invent or lose a path.
  const subscribedProjectKey = useMemo(
    () => [...new Set([...expandedProjectPaths, ...extraProjectPaths])].sort().join("\0"),
    [expandedProjectPaths, extraProjectPaths],
  );
  const subscribedProjectPaths = useMemo(
    () => (subscribedProjectKey === "" ? [] : subscribedProjectKey.split("\0")),
    [subscribedProjectKey],
  );
  const initializedProjectExpansion = useRef(false);
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
  // this effect's own dependencies -- which tears down the subscription that just
  // succeeded and re-subscribes, leaving the viewer back on "Loading".
  const [retryNonce, setRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const consecutiveFailures = useRef(0);
  // Whether this surface has ever been handed an inventory, which is what tells a
  // reopened stream apart from a first one.
  const deliveredInventory = useRef(false);

  useEffect(() => {
    // Not on every resubscribe: expanding a project reopens this stream, and a sidebar
    // that flipped back to "Loading projects" each time a row was unfolded would be
    // reporting the transport's business as the reader's.
    if (!deliveredInventory.current) setLoadingLayer(true);
    setLayerError(null);
    setRetrying(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onError = (reason: string) => {
      deliveredInventory.current = false;
      setLayerError(reason);
      setLoadingLayer(false);
      setRetrying(true);
      const delay = retryDelayMs(consecutiveFailures.current);
      consecutiveFailures.current += 1;
      timer = setTimeout(() => setRetryNonce((n) => n + 1), delay);
    };
    const onLoaded = () => {
      deliveredInventory.current = true;
      setLoadingLayer(false);
      setRetrying(false);
      consecutiveFailures.current = 0;
    };
    const stop = feed.subscribeInventory(subscribedProjectPaths, {
      onProjects: (snapshot) => {
        setProjects(snapshot);
        onLoaded();
      },
      onSessions: (projectPath, sessions) => {
        setSessionsByProject((current) => new Map(current).set(projectPath, sessions));
      },
    }, onError);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
    };
  }, [feed, retryNonce, subscribedProjectPaths]);

  useEffect(() => {
    if (projects.length === 0) return;
    if (!initializedProjectExpansion.current) {
      initializedProjectExpansion.current = true;
      // The remembered project, when it is still there, because a collapsed project's sessions
      // are not on the inventory stream at all -- so without expanding it first there is nothing
      // for the restore below to match against. Falls back to the first project, as before.
      const remembered = rememberedProjectPath;
      const openAt = remembered && projects.some((project) => project.projectPath === remembered)
        ? remembered
        : projects[0]!.projectPath;
      setExpandedProjectPaths(new Set([openAt]));
      return;
    }
    const currentPaths = new Set(projects.map((project) => project.projectPath));
    setExpandedProjectPaths((current) => {
      const next = new Set([...current].filter((path) => currentPaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [projects]);

  // A directory that is neither expanded nor open in a Bot session picker is no longer
  // on the stream, so keeping it would be keeping a copy that nothing refreshes.
  useEffect(() => {
    const subscribed = new Set(subscribedProjectPaths);
    setSessionsByProject((current) => {
      const next = new Map(
        [...current].filter(([projectPath]) => subscribed.has(projectPath)),
      );
      return next.size === current.size ? current : next;
    });
  }, [subscribedProjectPaths]);

  const toggleProject = useCallback((projectPath: string) => {
    setExpandedProjectPaths((current) => {
      const next = new Set(current);
      if (next.has(projectPath)) next.delete(projectPath);
      else next.add(projectPath);
      return next;
    });
  }, []);

  return {
    projects,
    sessionsByProject,
    loadingLayer,
    layerError,
    retrying,
    expandedProjectPaths,
    setExpandedProjectPaths,
    toggleProject,
    subscribedProjectPaths,
  };
}
