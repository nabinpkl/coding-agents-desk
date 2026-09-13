// The catalog of every session this machine can show, and the watchers that keep it true.
//
// The parts: `catalogState.ts` holds what the catalog is and tells subscribers,
// `claudeCatalog.ts`, `codexCatalog.ts` and `piCatalog.ts` each find one source's
// sessions, `catalogViews.ts` folds them into what a reader is handed, and this attaches
// the watchers and starts and stops the whole thing.

import chokidar from "chokidar";
import { watchTree, watchTreeEntries } from "@/transcripts/catalog/watchTree";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "@/config";
import { state } from "@/transcripts/transcriptState";
import type { SourceId } from "@/transcripts/sources/transcriptTypes";
import {
  broadcast,
  resetCatalogBroadcast,
  ROLLOUT_PATTERN,
  scheduleBroadcast,
} from "@/transcripts/catalog/catalogState";
import { projectSummaries } from "@/transcripts/catalog/catalogViews";
import { resolveStateDbPath } from "@/transcripts/sources/codexTranscript";

// The Pi watcher debounces here rather than in `piCatalog.ts`, because the debounce
// belongs to the watcher and the watcher is attached below.
let piReconcileTimer: ReturnType<typeof setTimeout> | null = null;
import { reconcileClaude, refreshClaudeSession } from "@/transcripts/catalog/claudeCatalog";
import {
  reconcileCodex,
  refreshCodexRollout,
  scheduleCodexReconcile,
  stopCodexReconcile,
} from "@/transcripts/catalog/codexCatalog";
import { reconcilePi } from "@/transcripts/catalog/piCatalog";

// Re-exported because the catalog is one subsystem with one address: nineteen callers
// already import it, and the parts below are how it is built rather than what it offers.
export type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
export {
  findSession,
  getSnapshot,
  getWatcherState,
  sessionKey,
  subscribeCatalog,
  SUMMARY_TITLE_CHARACTERS,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/catalogState";
export { canonicalProjectPath, isClaudeSessionCandidate } from "@/transcripts/catalog/catalogRecords";
export { refreshClaudeSession, resolveClaudeProject } from "@/transcripts/catalog/claudeCatalog";
export { readCodexThreadRows, refreshCodexRollout } from "@/transcripts/catalog/codexCatalog";
export { notifyPiSessionChanged, registerPiSession, resolvePiSession } from "@/transcripts/catalog/piCatalog";
export {
  projectSummaries,
  sessionCapabilities,
  sessionSummaries,
  summarizeSession,
} from "@/transcripts/catalog/catalogViews";

function attachSourceWatchers(): void {
  // One tree watch rather than one per transcript. All three of appearing, growing and being
  // deleted reconcile the same way here, so the event kind was never read and nothing is lost by
  // `fs.watch` not reporting it. See `watchTree` for what that saves.
  const claudeWatcher = watchTree({
    root: config.claudeProjectsDirectory,
    depth: 1,
    onPath: (path) => {
      void refreshClaudeSession(path).catch((error) => {
        console.error("agent feed Claude candidate reconcile failed", error);
      });
    },
    onError: (error) => {
      console.error("agent feed Claude catalog watcher failed", error);
    },
  });
  state.sourceWatchers.push(claudeWatcher);

  const databasePath = resolveStateDbPath();
  if (databasePath) {
    const databaseWatcher = chokidar.watch(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
      { ignoreInitial: true, persistent: true, awaitWriteFinish: false },
    );
    databaseWatcher.on("add", scheduleCodexReconcile);
    databaseWatcher.on("change", scheduleCodexReconcile);
    databaseWatcher.on("unlink", scheduleCodexReconcile);
    databaseWatcher.on("error", (error) => {
      console.error("agent feed Codex database watcher failed", error);
    });
    state.sourceWatchers.push(databaseWatcher);
  }

  const rolloutRoot = join(config.codexHomeDirectory, "sessions");
  // The one corpus here that reads the event kind, so it is the one that pays for rebuilding it:
  // appearing and disappearing change what the catalog CONTAINS, which only the database can
  // answer, while growing changes what one record SAYS, which the file can. `watchTreeEntries`
  // asks the filesystem for that distinction instead of holding a descriptor per rollout to be
  // told it -- there are over a thousand of those on this machine and only the handful being
  // written ever fire.
  const rolloutWatcher = watchTreeEntries({
    root: rolloutRoot,
    depth: 3,
    accepts: (path) => ROLLOUT_PATTERN.test(basename(path)),
    onEntry: (path, change) => {
      if (change === "written") {
        void refreshCodexRollout(path).catch((error) => {
          console.error("agent feed Codex rollout refresh failed", error);
        });
        return;
      }
      scheduleCodexReconcile();
    },
    onError: (error) => {
      console.error("agent feed Codex rollout watcher failed", error);
    },
  });
  state.sourceWatchers.push(rolloutWatcher);

  const schedulePi = (): void => {
    if (piReconcileTimer) clearTimeout(piReconcileTimer);
    piReconcileTimer = setTimeout(() => {
      piReconcileTimer = null;
      void reconcilePi().then(broadcast).catch((error) => {
        console.error("agent feed Pi catalog reconcile failed", error);
      });
    }, 40);
  };
  // Same reconcile whatever happened, so again the event kind was never read. The root
  // legitimately does not exist until pi has run once, which `watchTree` waits out.
  const piWatcher = watchTree({
    root: config.piSessionsDirectory,
    depth: 2,
    onPath: schedulePi,
    onError: (error) => console.error("agent feed Pi catalog watcher failed", error),
  });
  state.sourceWatchers.push(piWatcher);
}

/**
 * Runs one source's reconcile and contains its failure to that source.
 *
 * The sources are independent, and the caller of startCatalog treats a startup
 * failure as fatal. So one unreadable transcript store used to kill the whole
 * sidecar, taking every healthy source with it, and the restart read the same
 * unreadable thing and died again: a crash loop that left the agent feed with
 * no data at all rather than the partial data it had. Loud in the log, empty
 * for that source, alive for the rest.
 */
export async function reconcileSource(
  source: SourceId,
  reconcile: () => Promise<void>,
): Promise<void> {
  try {
    await reconcile();
  } catch (error) {
    console.error(JSON.stringify({
      event: "agent-feed-catalog-source-failed",
      source,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function reconcileAllSources(): Promise<void[]> {
  return Promise.all([
    reconcileSource("claude", reconcileClaude),
    reconcileSource("codex", reconcileCodex),
    reconcileSource("pi", reconcilePi),
  ]);
}

export async function startCatalog(): Promise<void> {
  if (state.sourceWatchers.length > 0 || state.watcherState !== "idle") return;
  const startedAt = performance.now();
  state.watcherState = "reconciling";
  await reconcileAllSources();
  attachSourceWatchers();
  state.discoveryTimer = setInterval(() => {
    void reconcileAllSources()
      .then(broadcast)
      .catch((error) => console.error("agent feed catalog safety rescan failed", error));
  }, config.discoveryRescanMs);
  state.watcherState = "live";
  console.log(JSON.stringify({
    event: "agent-feed-catalog-ready",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sessions: state.sessions.size,
    projects: projectSummaries().length,
  }));
}

export async function stopCatalog(): Promise<void> {
  resetCatalogBroadcast();
  stopCodexReconcile();
  if (piReconcileTimer) {
    clearTimeout(piReconcileTimer);
    piReconcileTimer = null;
  }
  if (state.discoveryTimer) {
    clearInterval(state.discoveryTimer);
    state.discoveryTimer = null;
  }
  for (const watcher of state.sourceWatchers) await watcher.close();
  state.sourceWatchers.length = 0;
  state.sessions.clear();
  resetCatalogBroadcast();
  state.watcherState = "idle";
}
