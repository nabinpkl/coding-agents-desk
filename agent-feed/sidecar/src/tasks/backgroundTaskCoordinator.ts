// One background-task probe for every session being watched, instead of one probe per session.
//
// The shape is `composerCoordinator`'s, for the same reason: what each subscriber wants is
// per-session, but almost everything it takes to answer is not. One process table, one pass over
// the session registry, and one `lsof` serve every subscriber in a tick, and only the transcript
// scan and the capture-file reads stay per-session -- none of which fork.
//
// The cost this removes was measured on a wall of 18 open sessions: each session's own tick forked
// `ps` once per registry record and `lsof` once for itself, so the machine spent about 1700 `ps`
// and 90 `lsof` forks per 10 seconds to answer 18 questions that shared one kernel. The registry
// pass and the process table were collapsed first; this is the `lsof`, which fell from 90 to 4.
//
// End to end, those 18 streams went from 10-14 points of system CPU to 0.8 on a ten-core machine,
// which is what 8 of them used to cost. Measure it by ALTERNATING idle and loaded windows and
// comparing paired deltas: a single before-and-after reads whatever else the machine started doing
// in between, and on a box running this many agents that drift is several times the signal. Two
// attempts here reported +26 and -5 points for a load that is really 0.8.
//
// The poll REMAINS a poll, and deliberately. macOS publishes no notification for an arbitrary
// process starting or exiting short of EndpointSecurity, which is its own entitlement and its own
// TCC grant, and this module's whole premise is that the kernel leads -- a killed task emits no
// completion record, so the transcript cannot be asked instead. Sharing the tick is what was
// available; deleting it was not.

import type { BackgroundTaskSnapshot } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { backgroundTaskSnapshot } from "@/tasks/backgroundTasks";
import {
  type CommandRunner,
  currentProcessTable,
  type ProcessRow,
  runCommand,
  type TaskShell,
  taskShellsByOwner,
} from "@/tasks/processProbe";
import { type ClaudeSessionProcess, liveSessionProcesses } from "@/tasks/sessionRegistry";

export type BackgroundTaskListener = (snapshot: BackgroundTaskSnapshot) => void;

const EMPTY: BackgroundTaskSnapshot = { running: [], finished: [], ownerAlive: false };

export interface BackgroundTaskCoordinatorOptions {
  run?: CommandRunner;
  pollIntervalMs?: number;
  now?: () => number;
  /** The session registry to read. Injected the same way `resolveInbox` takes it, for the tests. */
  sessionsDirectory?: string;
}

/** What the machine says about every watched session, gathered once. */
interface KernelPass {
  table: readonly ProcessRow[];
  owners: Map<string, ClaudeSessionProcess>;
  shellsByOwner: Map<number, TaskShell[]>;
}

/**
 * What a subscriber is told, reduced to the part worth telling it about.
 *
 * Elapsed time changes every tick by construction, so it cannot take part in the comparison or
 * nothing would ever be suppressed. The client re-derives it from `startedAt`, which is why that
 * field travels.
 */
function fingerprintOf(snapshot: BackgroundTaskSnapshot): string {
  return JSON.stringify({
    ownerAlive: snapshot.ownerAlive,
    running: snapshot.running.map((task) => [task.taskId, task.hasOutput]),
    finished: snapshot.finished.map((task) => [task.taskId, task.state]),
  });
}

export function createBackgroundTaskCoordinator(options: BackgroundTaskCoordinatorOptions = {}) {
  const run = options.run ?? runCommand;
  const pollIntervalMs = options.pollIntervalMs ?? config.backgroundTaskPollMs;
  const now = options.now ?? (() => Date.now());
  const sessionsDirectory = options.sessionsDirectory;

  const listeners = new Map<string, Set<BackgroundTaskListener>>();
  /** The last snapshot published per session, so a joining subscriber is not left blank. */
  const published = new Map<string, BackgroundTaskSnapshot>();
  const fingerprints = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshing: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  /**
   * Everything the kernel has to say about the watched sessions, in one table and one `lsof`.
   *
   * Throws rather than answering partially: a fork that failed is not evidence that a session has
   * no tasks, and the caller has to be able to tell those apart.
   */
  async function readKernel(sessionIds: readonly string[]): Promise<KernelPass> {
    const table = await currentProcessTable(run);
    const live = await liveSessionProcesses(table, sessionsDirectory);
    // Narrowed to the pass's own session list rather than re-reading `listeners`, so everything
    // below answers for exactly the set the pass started with.
    const watched = new Set(sessionIds);
    const owners = new Map<string, ClaudeSessionProcess>();
    for (const entry of live) {
      if (watched.has(entry.sessionId)) owners.set(entry.sessionId, entry);
    }
    const ownerPids = sessionIds
      .map((sessionId) => owners.get(sessionId)?.pid)
      .filter((pid): pid is number => pid !== undefined);
    return { table, owners, shellsByOwner: await taskShellsByOwner(run, ownerPids, table) };
  }

  /**
   * One pass over every watched session, resolving when THIS caller's sessions have been probed.
   *
   * A caller arriving mid-pass is queued behind it rather than joined to it. The running pass read
   * its session list before that caller existed, so joining it would resolve without ever having
   * asked about the session that prompted the call -- which is how a card opened while another was
   * refreshing would sit blank until the next tick. One follow-up is queued however many callers
   * arrive, because a single pass covers all of them.
   *
   * A session whose own probe throws gets an empty snapshot and the rest still publish: one
   * unreadable transcript must not silence the whole wall.
   */
  function refresh(): Promise<void> {
    if (!refreshing) {
      refreshing = runPass().finally(() => {
        refreshing = null;
      });
      return refreshing;
    }
    queued ??= refreshing.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }

  async function runPass(): Promise<void> {
    const sessionIds = [...listeners.keys()];
    if (sessionIds.length === 0) return;

    let kernel: KernelPass;
    try {
      kernel = await readKernel(sessionIds);
    } catch (error) {
      // The shared half failed, so there is nothing true to say about any session. Reported and
      // left alone: publishing "no tasks" here would erase a live task list because a fork failed.
      console.error("agent feed background task kernel pass failed", error);
      return;
    }

    const at = now();
    await Promise.all(sessionIds.map(async (sessionId) => {
      let snapshot: BackgroundTaskSnapshot;
      try {
        const owner = kernel.owners.get(sessionId) ?? null;
        snapshot = await backgroundTaskSnapshot(sessionId, {
          owner,
          shells: owner ? kernel.shellsByOwner.get(owner.pid) ?? [] : [],
          table: kernel.table,
        }, at);
      } catch (error) {
        // A probe that throws is a bug in the probe, not a reason to drop the subscriber. Report it
        // and keep the stream alive so a fixed probe recovers on the next tick.
        console.error("agent feed background task probe failed", error);
        snapshot = EMPTY;
      }
      publish(sessionId, snapshot);
    }));
  }

  function publish(sessionId: string, snapshot: BackgroundTaskSnapshot): void {
    const audience = listeners.get(sessionId);
    // Unsubscribed while the pass was in flight. Keeping its snapshot would hand the next
    // subscriber a reading from before it arrived.
    if (!audience) return;
    published.set(sessionId, snapshot);
    const fingerprint = fingerprintOf(snapshot);
    // Only send when something changed. A session sitting on one long task would otherwise repaint
    // the panel every couple of seconds for no new information -- and this stream runs to a phone
    // over a tailnet, where that is not free. A subscriber that joined since the last pass was
    // handed `published` on the spot, so suppressing here cannot leave anyone blank.
    if (fingerprints.get(sessionId) === fingerprint) return;
    fingerprints.set(sessionId, fingerprint);
    for (const listener of audience) listener(snapshot);
  }

  function schedule(): void {
    if (timer !== null || listeners.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      // Rescheduled AFTER the pass rather than on a fixed interval, so a slow probe cannot stack
      // passes on top of each other.
      void refresh().finally(schedule);
    }, pollIntervalMs);
  }

  return {
    /**
     * Follows one session's background tasks until the returned function is called.
     *
     * The current snapshot is delivered synchronously when there is one, so a second panel on a
     * session already being watched paints immediately instead of waiting out a tick.
     */
    subscribe(sessionId: string, listener: BackgroundTaskListener): () => void {
      const audience = listeners.get(sessionId) ?? new Set<BackgroundTaskListener>();
      audience.add(listener);
      listeners.set(sessionId, audience);

      const current = published.get(sessionId);
      if (current) listener(current);
      // Nothing known about this session yet, so the reader is looking at an empty list. The
      // running timer would answer eventually; this answers now.
      else void refresh();
      schedule();

      return () => {
        const live = listeners.get(sessionId);
        if (!live) return;
        live.delete(listener);
        if (live.size > 0) return;
        listeners.delete(sessionId);
        // Dropped with the last watcher, so a later subscriber is not handed a snapshot from
        // minutes ago as though it were current.
        published.delete(sessionId);
        fingerprints.delete(sessionId);
        if (listeners.size === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },

    /** Forces a pass, for tests that drive the clock themselves. */
    refresh,
  };
}

export const backgroundTasks = createBackgroundTaskCoordinator();
