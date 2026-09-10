// A file rendered rather than shown as source.
//
// Every renderer here is one the panel already has. The IDE this replaces shipped its own
// markdown-it, its own mermaid and its own notebook renderer, which is three copies of a job
// `features/activity-feed/markdown` was already doing.

import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import type { OpenFile } from "@/features/workspace-ide/useWorkspaceIde";

export function FilePreview({ file }: { file: OpenFile }) {
  if (file.kind === "notebook") return <NotebookPreview text={file.text} />;
  if (file.kind === "docx") return <DocxPreview path={file.path} />;
  if (file.kind === "html") {
    // Shown as source rather than executed. Rendering it would run someone else's script inside
    // the panel's origin, which is the one origin that can reach this machine's sidecar.
    return <PlainText text={file.text} />;
  }
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <Markdown content={file.text} />
    </div>
  );
}

function PlainText({ text }: { text: string }) {
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs">
      {text}
    </pre>
  );
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
  const document = cells.map((cell) => {
    const source = joined(cell.source);
    if (cell.cell_type === "markdown") return source;
    const outputs = (cell.outputs ?? [])
      .map((output) => joined(output.text))
      .filter(Boolean)
      .join("");
    const code = ["```python", source, "```"].join("\n");
    return outputs ? `${code}\n\n\`\`\`\n${outputs}\n\`\`\`` : code;
  }).join("\n\n");
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <Markdown content={document} />
    </div>
  );
}

/**
 * A Word document.
 *
 * The renderer is not installed: `docx-preview` could not be added from this machine, where every
 * `bun add` fails registry TLS verification (see `CodeEditor.tsx` and `TASKS.md`). The file reads
 * fine -- the sidecar serves its bytes on the content route and the tab opens -- so what is
 * missing is exactly the rendering, and saying so beats an empty pane that looks like a bug.
 */
function DocxPreview({ path }: { path: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
      <div className="grid max-w-sm gap-1">
        <p className="m-0 text-foreground">Word preview is not available</p>
        <p className="m-0">
          {path.split("/").pop()} is readable, but the panel has no Word renderer installed yet.
        </p>
      </div>
    </div>
  );
}
