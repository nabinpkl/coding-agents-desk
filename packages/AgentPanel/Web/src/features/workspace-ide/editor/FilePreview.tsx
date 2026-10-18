// A file rendered rather than shown as source.
//
// Every text renderer here is one the panel already has. The IDE this replaces shipped its own
// markdown-it, its own mermaid and its own notebook renderer, which is three copies of a job
// `features/activity-feed/markdown` was already doing. A PDF and a Word document are the two kinds
// with renderers of their own, pdf.js and docx-preview, because nothing else in the panel draws
// either (`PdfPreview.tsx`, `DocxPreview.tsx`).

import type { WorkspaceFileKind } from "@agentdesk/agent-feed-wire";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import { DocxPreview } from "@/features/workspace-ide/editor/DocxPreview";
import { PdfPreview } from "@/features/workspace-ide/editor/PdfPreview";

/**
 * What a file view needs to draw a file, and nothing about where it came from: an IDE tab, with
 * its revision and save state, and a Bot's read-only file both are one.
 */
export interface ViewedFile {
  path: string;
  kind: WorkspaceFileKind;
  text: string;
  /** The hash of the bytes on disk, which is what tells a rendered document it moved. */
  revision: string;
  /**
   * Where a binary-backed kind's bytes are fetched from: the IDE's content route or the Bot's.
   * Null where the transport has no address the page can load on its own.
   */
  contentUrl: string | null;
}

export function FilePreview({ file }: { file: ViewedFile }) {
  if (file.kind === "notebook") return <NotebookPreview text={file.text} />;
  if (file.kind === "docx") {
    return <DocxPreview name={fileName(file.path)} url={file.contentUrl} revision={file.revision} />;
  }
  if (file.kind === "pdf") {
    return <PdfPreview name={fileName(file.path)} url={file.contentUrl} revision={file.revision} />;
  }
  if (file.kind === "html") {
    // Shown as source rather than executed. Rendering it would run someone else's script inside
    // the panel's origin, which is the one origin that can reach this machine's sidecar.
    return <PlainText text={file.text} />;
  }
  return <MarkdownDocument text={file.text} />;
}

/**
 * A whole file, read as a document.
 *
 * The scroller holds no padding of its own: the measure, the gutters and the vertical rhythm are
 * one set of numbers and they live together in `markdown.css` under `--document`. Padding here
 * as well would be a second place that decides how wide a line is, and the two would drift.
 */
function MarkdownDocument({ text }: { text: string }) {
  return (
    <div className="h-full overflow-auto">
      <Markdown content={text} variant="document" />
    </div>
  );
}

function PlainText({ text }: { text: string }) {
  return <pre className="h-full overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs">{text}</pre>;
}

interface NotebookCell {
  cell_type?: string;
  source?: string[] | string;
  outputs?: { text?: string[] | string }[];
}

function joined(source: string[] | string | undefined): string {
  if (Array.isArray(source)) return source.join("");
  return source ?? "";
}

/**
 * A notebook, as markdown.
 *
 * Its cells become one document rather than a bespoke cell renderer: a markdown cell is markdown
 * already, and a code cell is a fenced block, which is a thing the panel's renderer draws with
 * highlighting and a copy button for free.
 */
function NotebookPreview({ text }: { text: string }) {
  let cells: NotebookCell[];
  try {
    const parsed = JSON.parse(text) as { cells?: NotebookCell[] };
    cells = parsed.cells ?? [];
  } catch {
    return <PlainText text={text} />;
  }
  const document = cells
    .map((cell) => {
      const source = joined(cell.source);
      if (cell.cell_type === "markdown") return source;
      const outputs = (cell.outputs ?? [])
        .map((output) => joined(output.text))
        .filter(Boolean)
        .join("");
      const code = ["```python", source, "```"].join("\n");
      return outputs ? `${code}\n\n\`\`\`\n${outputs}\n\`\`\`` : code;
    })
    .join("\n\n");
  return <MarkdownDocument text={document} />;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}
