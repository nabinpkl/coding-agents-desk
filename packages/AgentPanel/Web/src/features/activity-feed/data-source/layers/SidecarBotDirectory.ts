/**
 * What is in a Bot's directory: its uncommitted changes, its files, and one file's text or bytes.
 *
 * One more layer in the chain `sidecarRoutes.ts` describes, holding every read the panel makes
 * INTO a Bot's directory rather than about the Bot. The Bot's own routes rather than the IDE's,
 * because a Bot is a directory and not a registered workspace (see `BotGitStatus`); what the two
 * share is the shape of the answers, so the IDE's tree and file views draw both.
 */

import type {
  BotFileRead,
  BotGitDiff,
  BotGitStatus,
  BotTree,
} from "@agentdesk/agent-feed-wire";
import { parse } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarAgentSessions } from "@/features/activity-feed/data-source/SidecarAgentSessions";

function botPath(botId: string, rest: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/${rest}`;
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
  ): () => void {
    return this.transport.subscribe(botPath(botId, "git/stream"), {
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
  async botGitDiff(botId: string, path: string): Promise<BotGitDiff> {
    const query = new URLSearchParams({ path });
    return parse<BotGitDiff>(
      await this.transport.request("GET", botPath(botId, `git/diff?${query}`)),
    );
  }

  /**
   * The Bot's directory as the explorer draws it, with `expanded` listed beneath their parents.
   *
   * The whole set on every call, because expansion is this reader's and the sidecar keeps none.
   */
  async botTree(botId: string, expanded: readonly string[]): Promise<BotTree> {
    const query = new URLSearchParams(expanded.map((path) => ["expanded", path]));
    const suffix = expanded.length > 0 ? `?${query}` : "";
    return parse<BotTree>(await this.transport.request("GET", botPath(botId, `tree${suffix}`)));
  }

  /** One file in the Bot's directory, read-only. */
  async botFile(botId: string, path: string): Promise<BotFileRead> {
    const query = new URLSearchParams({ path });
    return parse<BotFileRead>(await this.transport.request("GET", botPath(botId, `file?${query}`)));
  }

  /**
   * Where a binary-backed file's bytes are fetched from, which its read answers without. Null where
   * the transport has no address the page can load on its own.
   */
  botContentUrl(botId: string, path: string): string | null {
    const query = new URLSearchParams({ path });
    return this.transport.resourceUrl?.(botPath(botId, `content?${query}`)) ?? null;
  }
}
