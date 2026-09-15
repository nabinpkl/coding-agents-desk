"use client";

import { EventFileImage } from "@/features/activity-feed/blocks/EventImageBlock";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityBlock } from "@/features/activity-feed/useSessionEventsStream";

/**
 * The files a call named, drawn: the sentence it sent them with, and the pictures themselves.
 *
 * `SendUserFile` is what this was built for, and every part of it was unreadable in the feed. Its
 * result enumerates each absolute path a second time beside a `file_uuid`, which is the delivery
 * system's handle and nothing a reader can act on; the sentence saying what the files were sat in
 * the call's `caption`, a key nothing rendered; and the pictures -- usually the whole point of the
 * message -- were a list of names in a temp directory.
 *
 * It draws any call's files, not just that one's, because the same gap is everywhere: a command
 * that renders a chart names the file it wrote and nothing in the transcript holds the picture.
 *
 * The list comes from the CALL rather than from its result, because the call is what asked; a
 * result that failed still shows its own text under this. A file that is no longer there shows as
 * its name, which is what the row said before there was a picture to draw.
 */
export function SentFilesBlock({
  files,
  caption,
  ctx,
  eventIndex,
  blockIndex,
}: {
  files: string[];
  caption?: string;
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
}) {
  return (
    <div
      className="space-y-1.5 rounded-sm border border-border/50 bg-muted/30 px-2 py-1.5"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      {caption ? (
        <p className="leading-(--agent-panel-prose-leading) text-foreground">{caption}</p>
      ) : null}
      <ul className="flex flex-wrap gap-2">
        {files.map((path, fileIndex) => {
          const name = fileName(path);
          return (
            // The whole path in `title`, since it is the one thing a reader might want and the one
            // thing that cannot be read at a glance.
            <li key={`${fileIndex}-${path}`} className="min-w-0 space-y-0.5" title={path}>
              {isPicture(path) ? (
                <EventFileImage
                  ctx={ctx}
                  eventIndex={eventIndex}
                  blockIndex={blockIndex}
                  fileIndex={fileIndex}
                  name={name}
                />
              ) : null}
              <div className="truncate font-mono text-foreground/70">{name}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The files a tool call names, or null for a call that names none.
 *
 * Read off the block rather than derived from `input`: the sidecar resolved this list, and a
 * picture in it is addressed by its position, so deriving a second order here is how the third
 * file starts answering with the fifth.
 */
export function sentFiles(block: ActivityBlock): string[] | null {
  return block.files?.length ? block.files : null;
}

export function fileName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Whether to ask for this file as a picture.
 *
 * By NAME here and by the bytes at the sidecar, which is the same split the composer uses: the
 * panel is deciding whether to put an `<img>` on the row at all, and the four names are Claude's
 * own list. A file that lies about itself is refused where the bytes are, not here.
 */
export function isPicture(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
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
