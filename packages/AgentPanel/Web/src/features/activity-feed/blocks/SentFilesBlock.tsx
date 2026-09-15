"use client";

/**
 * What a call handed to the reader: the sentence it sent them with, and the files by name.
 *
 * `SendUserFile` is the call, and both halves of it were unreadable in the feed. Its result
 * enumerates every absolute path a second time beside a `file_uuid`, which is the delivery
 * system's handle and nothing a reader can act on -- three files filled a screen with temp
 * directories, and the sentence saying what they were sat above all of it in the call's `caption`,
 * a key nothing rendered.
 *
 * The names come from the CALL rather than from its result, because the call is what asked; a
 * result that failed still shows its own text under this.
 */
export function SentFilesBlock({ files, caption }: { files: string[]; caption?: string }) {
  return (
    <div
      className="space-y-1 rounded-sm border border-border/50 bg-muted/30 px-2 py-1.5"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      {caption ? (
        <p className="leading-(--agent-panel-prose-leading) text-foreground">{caption}</p>
      ) : null}
      <ul className="space-y-0.5">
        {files.map((path) => (
          // The whole path in `title`, since it is the one thing a reader might want and the one
          // thing that cannot be read at a glance.
          <li key={path} className="truncate font-mono text-foreground/70" title={path}>
            {path.split("/").pop() || path}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The files a tool call handed over, or null for a call that handed over none. */
export function sentFiles(input: Record<string, unknown> | undefined): string[] | null {
  const files = input?.files;
  if (!Array.isArray(files)) return null;
  const paths = files.filter((file): file is string => typeof file === "string" && file.trim() !== "");
  return paths.length ? paths : null;
}

/**
 * The result's text with the delivery handles taken out.
 *
 * One line per file of `<absolute path> -> file_uuid: <uuid>` says nothing the list above does not,
 * in the most expensive way available. What is left -- "3 files delivered to user.", or whatever a
 * failure says instead -- is the part that is about the reader's own request.
 */
export function withoutFileHandles(preview: string | undefined): string {
  return (preview ?? "")
    .split("\n")
    .filter((line) => !/file_uuid:/.test(line))
    .join("\n")
    .trim();
}
