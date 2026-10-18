// Which project the IDE is looking at, and the four things you can do to that list.
//
// The roster used to be a switcher and an add button, and nothing else: a list you could only ever
// grow. The sidecar has carried `remove`, `rename` and `reorder` since the routes landed; what was
// missing was any way to reach them, so a mistyped path stayed in the roster for good.
//
// A menu rather than controls on the header, because these are rare next to switching projects and
// a row of five buttons above a file tree reads as the tree's toolbar. Rename edits in place and
// remove asks first -- it unregisters a project rather than deleting anything on disk, but that
// distinction is not visible from a button, so the confirm says which it is.

import { useState } from "react";
import { selectOnMount } from "@/hooks/dom/refCallbacks";
import { useStateFor } from "@/hooks/state/useStateFor";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import type { WorkspaceSummary } from "@agentdesk/agent-feed-wire";

const CONTROL =
  "grid h-7 w-8 shrink-0 place-items-center rounded-md border border-border" +
  " outline-none transition-colors hover:bg-muted/60 active:bg-muted" +
  " focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset";

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none" +
  " hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset" +
  " disabled:opacity-40 disabled:hover:bg-transparent";

export function WorkspaceRoster({
  workspaces,
  workspaceId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
  onReorder,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  // Closed again on a workspace change rather than left open over a different project: the actions
  // in the menu all name "this workspace", and which one that is has just changed underneath.
  const [mode, setMode] = useStateFor<"closed" | "open" | "renaming" | "confirming">(workspaceId, () => "closed");
  const [draftName, setDraftName] = useState("");

  const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  const current = index < 0 ? null : workspaces[index]!;

  function move(by: -1 | 1) {
    if (!current || index < 0) return;
    const target = index + by;
    if (target < 0 || target >= workspaces.length) return;
    const ids = workspaces.map((workspace) => workspace.id);
    ids.splice(target, 0, ...ids.splice(index, 1));
    onReorder(ids);
  }

  function commitRename() {
    const name = draftName.trim();
    setMode("open");
    if (current && name && name !== current.name) onRename(current.id, name);
  }

  return (
    <div className="shrink-0 border-b border-border">
      <header className="flex min-h-[42px] items-center gap-1.5 px-2">
        <select
          aria-label="Select workspace"
          value={workspaceId ?? ""}
          disabled={workspaces.length === 0}
          onChange={(event) => onSelect(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5
            outline-none focus-visible:ring-2 focus-visible:ring-primary
            disabled:text-muted-foreground"
        >
          {workspaces.length === 0 ? (
            <option value="">No workspaces</option>
          ) : (
            workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          aria-label="Manage workspace"
          aria-expanded={mode !== "closed"}
          title="Manage workspace"
          disabled={!current}
          onClick={() => {
            setDraftName(current?.name ?? "");
            setMode((previous) => (previous === "closed" ? "open" : "closed"));
          }}
          className={`${CONTROL} disabled:opacity-40`}
        >
          <MoreHorizontal className="size-4" />
        </button>
        <button type="button" aria-label="Add workspace" title="Add workspace" onClick={onAdd} className={CONTROL}>
          <Plus className="size-4" />
        </button>
      </header>

      {mode === "closed" || !current ? null : (
        <div className="border-t border-border bg-muted/30 px-2 py-1.5 text-sm">
          {mode === "renaming" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                commitRename();
              }}
            >
              <input
                ref={selectOnMount}
                aria-label="Workspace name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMode("open");
                }}
                className="h-7 w-full rounded-md border border-border bg-background px-1.5
                      outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </form>
          ) : mode === "confirming" ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Says which of the two things this is. Nothing on disk is touched, and a
                      button alone cannot carry that. */}
              <span className="flex-1 text-xs text-muted-foreground">
                Remove {current.name} from the roster? The folder stays on disk.
              </span>
              <button
                type="button"
                onClick={() => {
                  setMode("closed");
                  onRemove(current.id);
                }}
                className="rounded-md border border-destructive px-2 py-1 text-xs
                      text-destructive outline-none hover:bg-destructive/10
                      focus-visible:ring-2 focus-visible:ring-primary"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={() => setMode("open")}
                className="rounded-md border border-border px-2 py-1 text-xs outline-none
                      hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="grid gap-0.5">
              <button type="button" className={MENU_ITEM} onClick={() => setMode("renaming")}>
                Rename
              </button>
              <button type="button" className={MENU_ITEM} disabled={index <= 0} onClick={() => move(-1)}>
                <ChevronUp className="size-4" />
                Move up
              </button>
              <button
                type="button"
                className={MENU_ITEM}
                disabled={index < 0 || index >= workspaces.length - 1}
                onClick={() => move(1)}
              >
                <ChevronDown className="size-4" />
                Move down
              </button>
              <button type="button" className={`${MENU_ITEM} text-destructive`} onClick={() => setMode("confirming")}>
                <Trash2 className="size-4" />
                Remove
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
