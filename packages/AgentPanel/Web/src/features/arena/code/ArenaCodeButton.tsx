// The way into a quick, read-only look at one of the arena's folders: the arena home from the
// runs list, a run's folder from its header, a contestant's worktree from its lane's head.
//
// The Bot card's code button over the arena's own routes: the same modal, with its files on one
// tab and what is uncommitted on the other. The git subscription lives only while the modal is
// open, since nothing else here shows it.

import { CodeXml } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { arenaFolderSource, subscribeArenaGit, type ArenaPlace } from "@/features/arena/code/arenaCode";
import { ICON_BUTTON } from "@/features/arena/arenaVocabulary";
import { FolderCodeDialog } from "@/features/folder-code/FolderCodeDialog";
import { useFolderGitStatus } from "@/features/folder-code/folderSource";

export function ArenaCodeButton({
  transport,
  place,
  label,
  title,
  path,
  className = "",
}: {
  transport: AgentHttpTransport;
  place: ArenaPlace;
  /** What the button opens, said in full: its accessible name and its tooltip. */
  label: string;
  /** Whose folder it is, the modal's heading. */
  title: string;
  /** Where the folder is on the disk. */
  path: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        className={`${ICON_BUTTON} ${className}`}
      >
        <CodeXml aria-hidden className="size-4" />
      </button>
      {open ? (
        <ArenaCodeDialog transport={transport} place={place} title={title} path={path} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ArenaCodeDialog({
  transport,
  place: { runId, contestantId },
  title,
  path,
  onClose,
}: {
  transport: AgentHttpTransport;
  place: ArenaPlace;
  title: string;
  path: string;
  onClose: () => void;
}) {
  const source = useMemo(() => arenaFolderSource(transport, { runId, contestantId }), [transport, runId, contestantId]);
  const subscribe = useMemo(() => subscribeArenaGit(transport, { runId, contestantId }), [transport, runId, contestantId]);
  const git = useFolderGitStatus(subscribe);
  return (
    <FolderCodeDialog
      titleId="arena-code-title"
      title={title}
      path={path}
      sectionsLabel="Folder sections"
      source={source}
      git={git}
      initialSection="explorer"
      onClose={onClose}
    />
  );
}
