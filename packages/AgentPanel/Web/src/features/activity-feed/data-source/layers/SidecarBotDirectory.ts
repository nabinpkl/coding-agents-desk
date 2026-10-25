/**
 * What is in a Bot's directory: its uncommitted changes, its files, and one file's text or bytes.
 *
 * One more layer in the chain `sidecarRoutes.ts` describes, holding every read the panel makes
 * INTO a Bot's directory rather than about the Bot. The Bot's own routes rather than the IDE's,
 * because a Bot is a directory and not a registered workspace (see `BotGitStatus`); what the two
 * share is the shape of the answers, so the IDE's tree and file views draw both.
 */

import type { BotFileRead, BotGitDiff, BotGitStatus, BotSessionRef, BotTree } from "@agentdesk/agent-feed-wire";
import { parse } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarAgentSessions } from "@/features/activity-feed/data-source/SidecarAgentSessions";

/**
 * One of a Bot's routes, with its query. `session` names one of the Bot's sessions, for a read of the
 * worktree that session works in rather than of the Bot's directory: the sidecar finds the folder,
 * so the panel never sends a path.
 */
function botPath(botId: string, rest: string, query: [string, string][] = [], session?: BotSessionRef): string {
  const named: [string, string][] = session
    ? [
        ["source", session.source],
        ["session", session.sessionId],
      ]
    : [];
  const search = new URLSearchParams([...query, ...named]).toString();
  return `/api/bots/${encodeURIComponent(botId)}/${rest}${search ? `?${search}` : ""}`;
}

export class SidecarBotDirectory extends SidecarAgentSessions {
  /**
   * Follows what is uncommitted in the Bot's directory: the status now, and again whenever the
   * sidecar's watch of that repository sees it move. Returns unsubscribe.
   */
  subscribeBotGit(
    botId: string,
    onStatus: (status: BotGitStatus) => void,
    onError: (reason: string) => void,
    session?: BotSessionRef,
  ): () => void {
    return this.transport.subscribe(botPath(botId, "git/stream", [], session), {
      onMessage: (payload) => {
        try {
          const message = JSON.parse(payload) as Partial<BotGitStatus> & {
            error?: { message?: string };
          };
          if (message.error) onError(message.error.message ?? "Git stream failed");
          else if (typeof message.repository === "boolean" && Array.isArray(message.entries)) {
            onStatus(message as BotGitStatus);
          } else onError("Git stream returned an invalid status");
        } catch {
          onError("Git stream returned malformed JSON");
        }
      },
      onError,
    });
  }

  /** One path's uncommitted change in the Bot's directory, against `HEAD`. */
  async botGitDiff(botId: string, path: string, session?: BotSessionRef): Promise<BotGitDiff> {
    return parse<BotGitDiff>(
      await this.transport.request("GET", botPath(botId, "git/diff", [["path", path]], session)),
    );
  }

  /**
   * The Bot's directory as the explorer draws it, with `expanded` listed beneath their parents.
   *
   * The whole set on every call, because expansion is this reader's and the sidecar keeps none.
   */
  async botTree(botId: string, expanded: readonly string[], session?: BotSessionRef): Promise<BotTree> {
    const query = expanded.map((path): [string, string] => ["expanded", path]);
    return parse<BotTree>(await this.transport.request("GET", botPath(botId, "tree", query, session)));
  }

  /** One file in the Bot's directory, read-only. */
  async botFile(botId: string, path: string, session?: BotSessionRef): Promise<BotFileRead> {
    return parse<BotFileRead>(await this.transport.request("GET", botPath(botId, "file", [["path", path]], session)));
  }

  /**
   * Where a binary-backed file's bytes are fetched from, which its read answers without. Null where
   * the transport has no address the page can load on its own.
   */
  botContentUrl(botId: string, path: string, session?: BotSessionRef): string | null {
    return this.transport.resourceUrl?.(botPath(botId, "content", [["path", path]], session)) ?? null;
  }
}
