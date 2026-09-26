// One file on screen: its source, or its rendered preview.
//
// The IDE's editor pane and a Bot's quick look into its code both draw a file this way, so which
// kinds open rendered, which have a source to switch to, and what the switch says live here once
// rather than in each. Where the file came from -- a shared IDE tab or a read-only Bot read -- is
// the caller's, and so is whether it can be typed into.

import { Eye, Pencil } from "lucide-react";
import type { WorkspaceFileKind } from "@agentdesk/agent-feed-wire";
import { CodeEditor } from "@/features/workspace-ide/editor/CodeEditor";
import { FilePreview, type ViewedFile } from "@/features/workspace-ide/editor/FilePreview";
import type { FileView } from "@/features/workspace-ide/workspaceIdePreferences";

/** A toolbar control beside a file: an icon, pressed while its state holds. */
export const FILE_CONTROL = "grid h-7 w-8 shrink-0 place-items-center rounded-md text-muted-foreground"
  + " outline-none transition-colors hover:bg-muted/60 hover:text-foreground"
  + " focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
  + " aria-pressed:bg-muted aria-pressed:text-foreground";

// `grid-flow-col` because `FILE_CONTROL` is a grid and a grid stacks its children: the icon sat on
// top of its own label in both of the controls that carry one, inside a button 28px tall.
/** The same control carrying a word beside its icon. */
export const FILE_CONTROL_LABELLED = "w-auto grid-flow-col gap-1 px-2 text-xs";

/**
 * How a file opens when its reader has not said otherwise.
 *
 * Markdown is rendered. It is the one editable kind whose source is a means to a rendered
 * document rather than the document -- a reader opening `AGENTS.md` is almost always reading it,
 * and the ones editing it are one press away. HTML is deliberately NOT here: its preview shows
 * the source anyway, because rendering it would run someone else's script inside the one origin
 * that can reach this machine's sidecar.
 *
 * A notebook and a Word document have no source view at all, so their default is the only thing
 * they have; `hasSource` says so for the toggle.
 */
export function defaultFileView(kind: WorkspaceFileKind | undefined): FileView {
  return kind === "markdown" || kind === "docx" || kind === "notebook" ? "preview" : "source";
}

/**
 * Whether a kind has a source view to switch to. A notebook and a Word document are drawn from a
 * parsed model, and the sidecar refuses a write to either, so no toggle is offered for them.
 */
export function hasSource(kind: WorkspaceFileKind | undefined): boolean {
  return kind !== "docx" && kind !== "notebook";
}

export function FileBody({
  file,
  preview,
  onChange,
}: {
  file: ViewedFile;
  preview: boolean;
  /** Absent where the file is only read. */
  onChange?: (text: string) => void;
}) {
  if (preview || !hasSource(file.kind)) return <FilePreview file={file} />;
  return <CodeEditor path={file.path} text={file.text} onChange={onChange} />;
}

/**
 * The switch between a file's source and its preview. Named for where it goes: "Edit" where the
 * source can be typed into, "Source" where it can only be read.
 */
export function FileViewToggle({
  preview,
  editable,
  onToggle,
}: {
  preview: boolean;
  editable: boolean;
  onToggle: () => void;
}) {
  const toSource = editable ? "Edit" : "Source";
  return (
    <button
      type="button"
      aria-label={preview ? (editable ? "Edit file" : "Show file source") : "Show file preview"}
      onClick={onToggle}
      className={`${FILE_CONTROL} ${FILE_CONTROL_LABELLED}`}
    >
      {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
      {preview ? toSource : "Preview"}
    </button>
  );
}
