// The arena's folders as the folder viewer reads them: the arena home, one run's folder, or one
// contestant's worktree, over `/api/arena/code/*`.
//
// A place names the folder by what it belongs to -- no run is the arena home, a run its folder, a
// run and a contestant that contestant's worktree -- and the sidecar resolves the path, so the
// panel never sends one.

import type { FolderFileRead, FolderGitDiff, FolderGitStatus, FolderTree } from "@agentdesk/agent-feed-wire";
import { parse } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { FolderGitSubscribe, FolderSource } from "@/features/folder-code/folderSource";

export interface ArenaPlace {
  runId?: string;
  contestantId?: string;
}

function codePath(read: string, place: ArenaPlace, extra: [string, string][] = []): string {
  const query = new URLSearchParams([
    ...(place.runId ? [["run", place.runId] as [string, string]] : []),
    ...(place.runId && place.contestantId ? [["contestant", place.contestantId] as [string, string]] : []),
    ...extra,
  ]);
  const text = query.toString();
  return `/api/arena/code/${read}${text ? `?${text}` : ""}`;
}

export function arenaFolderSource(transport: AgentHttpTransport, place: ArenaPlace): FolderSource {
  return {
    key: `arena:${place.runId ?? "home"}/${place.contestantId ?? ""}`,
    tree: async (expanded) =>
      parse<FolderTree>(
        await transport.request(
          "GET",
          codePath(
            "tree",
            place,
            expanded.map((path) => ["expanded", path]),
          ),
        ),
      ),
    file: async (path) =>
      parse<FolderFileRead>(await transport.request("GET", codePath("file", place, [["path", path]]))),
    contentUrl: (path) => transport.resourceUrl?.(codePath("content", place, [["path", path]])) ?? null,
    gitDiff: async (path) =>
      parse<FolderGitDiff>(await transport.request("GET", codePath("git/diff", place, [["path", path]]))),
  };
}

/** Follows what is uncommitted in the place's folder, now and whenever the sidecar sees it move. */
export function subscribeArenaGit(
  transport: AgentHttpTransport,
  place: ArenaPlace,
): FolderGitSubscribe<FolderGitStatus> {
  return (onStatus, onError) =>
    transport.subscribe(codePath("git/stream", place), {
      onMessage: (payload) => {
        try {
          const message = JSON.parse(payload) as Partial<FolderGitStatus> & { error?: { message?: string } };
          if (message.error) onError(message.error.message ?? "Git stream failed");
          else if (typeof message.repository === "boolean" && Array.isArray(message.entries)) {
            onStatus(message as FolderGitStatus);
          } else onError("Git stream returned an invalid status");
        } catch {
          onError("Git stream returned malformed JSON");
        }
      },
      onError,
    });
}
