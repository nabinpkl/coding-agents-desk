// Which window shows a session, per source.
//
// Two resolvers, because the two applications answer different questions: Claude's is
// the process tree, Codex's is the app's own state joined to its accessibility tree.
// Split out of the coordinator so the join lives beside the resolvers it joins, not
// beside the polling that happens to call it.

import type {
  DesktopAuditSnapshot,
  WindowInputReason,
  WindowTarget,
} from "@agentdesk/agent-feed-wire";
import {
  desktopOwner,
  type ProcessRow,
  resolve,
  sessionOwner,
  target as targetWindow,
} from "./claudeSessionResolver.ts";
import {
  codexMainPids,
  type CodexWindowSummary,
  matchWindow,
  target as codexTarget,
  threadName,
  threadRecord,
} from "./codexSessionResolver.ts";
import type { SessionKey } from "./composerTypes.ts";
import type { WindowAccess } from "./composerWindowAccess.ts";

export function createTargetResolver(
  access: WindowAccess,
  leaseFailureFor: (key: SessionKey) => WindowInputReason | undefined,
) {
  const { call } = access;

  /**
   * The window for a session, or the reason there is not one.
   *
   * Two sources, in order: the argv resolver, then the per-pid registry for a brand-new session
   * whose id was never written into any argv. A lease failure short-circuits both -- the window is
   * stranded and re-resolving would report a target the writer cannot use.
   */
  async function resolveTarget(
    key: SessionKey,
    rows: ProcessRow[],
    snapshot: DesktopAuditSnapshot,
  ): Promise<WindowTarget | { reason: WindowInputReason }> {
    const leaseFailure = leaseFailureFor(key);
    if (leaseFailure) return { reason: leaseFailure };
    return key.source === "codex"
      ? await resolveCodexTarget(key.sessionId, rows, snapshot)
      : resolveClaudeTarget(key.sessionId, rows, snapshot);
  }

  function resolveClaudeTarget(
    sessionId: string,
    rows: ProcessRow[],
    snapshot: DesktopAuditSnapshot,
  ): WindowTarget | { reason: WindowInputReason } {
    const owner = sessionOwner(resolve(sessionId, rows));
    const pid = typeof owner === "number" ? owner : desktopOwner(sessionId, rows);
    if (pid === null) return typeof owner === "number" ? { reason: "no-window" } : owner;
    const resolved = targetWindow(sessionId, pid, snapshot);
    return resolved.ok ? resolved.target : { reason: resolved.reason };
  }

  /**
   * The Codex window showing a thread.
   *
   * Three joins, none of which the process tree can do: the app's registry gives the thread its `cwd`
   * and lowercased title, the JSONL index gives the title the app actually SHOWS, and the helper's
   * window summaries give each window's header or Recents identity. Exactly one match is a window;
   * more than one is refused, because a write into the wrong conversation looks successful until the
   * text appears there.
   */
  async function resolveCodexTarget(
    sessionId: string,
    rows: ProcessRow[],
    snapshot: DesktopAuditSnapshot,
  ): Promise<WindowTarget | { reason: WindowInputReason }> {
    const pids = codexMainPids(rows);
    if (pids.length === 0) return { reason: "not-running" };
    if (pids.length > 1) return { reason: "multiple-instances" };
    const mainPid = pids[0]!;

    const record = await threadRecord(sessionId);
    if (!record) return { reason: "no-window" };

    const answer = await call("codex-window-summaries", { mainPid });
    const windows = (answer.windows ?? []) as CodexWindowSummary[];
    const match = matchWindow(record.title, record.cwd, threadName(sessionId), windows);
    if (match.kind === "ambiguous") return { reason: "ambiguous-window" };
    if (match.kind === "not-found") return { reason: "no-window" };
    return codexTarget(sessionId, mainPid, match.window.windowID, snapshot);
  }

  /**
   * Takes AX handles on every Codex window while they are reachable.
   *
   * Codex Desktop will not list windows on other Spaces, so a thread living in one cannot be resolved
   * until a handle has been taken for it, and taking one means the window must be here. Doing this
   * when a thread is SELECTED rather than on the poll is what keeps that to once per window.
   */
  async function captureCodexWindows(rows: ProcessRow[]): Promise<void> {
    const pids = codexMainPids(rows);
    if (pids.length !== 1) return;
    await call("codex-capture-windows", { mainPid: pids[0]! }).catch(() => {});
  }

  return { resolveTarget, captureCodexWindows };
}

/** What `createTargetResolver` hands back, so the other parts can name it. */
export type TargetResolver = ReturnType<typeof createTargetResolver>;
