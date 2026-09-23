import { config } from "@/config/config";
import { type ProcessRow } from "@/desktop/claudeSessionResolver";

/**
 * Restarts a wedged Claude Desktop web contents by terminating its renderer children.
 *
 * A window can sit on the current Space, focused, with the composer plainly on screen, and still
 * expose no prompt field: Chromium materializes a web contents' accessibility tree under conditions
 * nothing here controls, and a contents that never built its tree reads as "composer missing". The
 * deterministic recovery is to terminate the renderer children -- Chromium respawns the contents
 * fresh, which builds the tree. Verified against the live app: after killing the conversation
 * renderer, the composer `AXTextArea` appeared within a second and stayed.
 *
 * Renderer pids come from the process table, never from CPU or activity heuristics: a wedged pane
 * can be idle or busy, and the deterministic fact is its parent.
 *
 * This is policy, not capability -- a process table read, two timers, and a signal, all of which Bun
 * does -- so it lives here rather than in the helper. Both gates and the signal are things that have
 * been tuned before and will be again.
 */

/** SIGTERM, the same signal Chromium itself uses for process teardown. */
const SIGTERM = "SIGTERM";

export interface RendererReviver {
  /**
   * Records that the composer was found, resetting the missing streak.
   *
   * Without the reset, a tree that flaps on a sub-minute cycle would accumulate enough missing time
   * to be killed -- and each kill reloads the user's window. Found observations are the evidence the
   * wedge is over.
   */
  noteFound(claudeMainPid: number): void;
  /**
   * Records a composer-missing observation, terminating renderers when both gates allow. Returns the
   * terminated pids: empty when the streak is too young, the cooldown is still running, or the
   * process has no live renderers.
   */
  noteMissing(claudeMainPid: number, rows: ProcessRow[], nowMs: number): number[];
}

export interface RendererReviverOptions {
  /** How long the composer must be CONTINUOUSLY missing before a kill. */
  minMissingMs?: number;
  /** One kill per Claude process per this window, bounding a tree that never rebuilds. */
  cooldownMs?: number;
  terminate?: (pid: number) => void;
}

/**
 * Every `--type=renderer` child of the main pid, ascending.
 *
 * Parent pid scopes the match to this Claude process, and the renderer marker scopes it to
 * Chromium's renderer children: GPU, network, utility, and the main binary carry different markers,
 * and killing one of those would not rebuild web contents.
 */
export function rendererPids(claudeMainPid: number, rows: ProcessRow[]): number[] {
  return rows
    .filter((row) => row.parentPid === claudeMainPid && row.arguments.includes("--type=renderer"))
    .map((row) => row.pid)
    .sort((a, b) => a - b);
}

export function createRendererReviver(options: RendererReviverOptions = {}): RendererReviver {
  const minMissingMs = options.minMissingMs ?? config.claudeRendererReviveMinMissingMs;
  const cooldownMs = options.cooldownMs ?? config.claudeRendererReviveCooldownMs;
  const terminate = options.terminate ?? ((pid: number) => {
    try {
      process.kill(pid, SIGTERM);
    } catch {
      // Already gone, which is the outcome the kill was for.
    }
  });

  /** First missing observation per Claude main pid; cleared by `noteFound`. */
  const missingSince = new Map<number, number>();
  /** Last revive attempt per Claude main pid. */
  const lastRevive = new Map<number, number>();

  return {
    noteFound(claudeMainPid) {
      missingSince.delete(claudeMainPid);
    },
    noteMissing(claudeMainPid, rows, nowMs) {
      const since = missingSince.get(claudeMainPid);
      if (since === undefined) {
        missingSince.set(claudeMainPid, nowMs);
        return [];
      }
      if (nowMs - since < minMissingMs) return [];
      const last = lastRevive.get(claudeMainPid);
      if (last !== undefined && nowMs - last < cooldownMs) return [];
      const pids = rendererPids(claudeMainPid, rows);
      if (pids.length === 0) return [];
      lastRevive.set(claudeMainPid, nowMs);
      for (const pid of pids) terminate(pid);
      return pids;
    },
  };
}
