import { useState, type ReactNode } from "react";
import { useDataSource } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import { CHIP_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { ImageLightbox } from "@/features/image-viewer/ImageLightbox";

/**
 * A picture in the feed, as a thumbnail that opens larger.
 *
 * The thumbnail is the whole control, the way it is in the composer's strip: the large target
 * opens it, and there is nothing else to do with a picture that has already been sent.
 *
 * Where there is no picture to show it says so rather than disappearing, unless the caller has
 * something better to leave behind -- a row that prints the file's name needs no chip saying the
 * same thing twice.
 *
 * Takes an address rather than finding one, because two different things in a row are pictures:
 * an image block inside a message, and a file a call handed to the reader. They are addressed
 * differently and look identical, so only the addressing is duplicated.
 */
export function EventPicture({
  url,
  alt,
  title,
  label = "Open image larger",
  missing,
  compact = false,
}: {
  /** Where the bytes are, or null where this view has no address it can load. */
  url: string | null;
  /** What the opened picture is, for a reader who cannot see it. */
  alt: string;
  /** The lightbox's own caption: the file's name, where the picture came from one. */
  title?: string;
  /** What the control does, said per picture: a row can carry several, and they are not the same
   *  one repeated. */
  label?: string;
  /** What stands where the picture cannot be drawn. A caller whose row names the file anyway
   *  passes `null`: the name is the fallback, and a chip beside it would say it twice. */
  missing?: ReactNode;
  /** One line tall, for a collapsed tool call's header, where it says what the call carried. */
  compact?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  // WHICH address failed, not merely that one did: a row whose picture moves -- a live message
  // becoming a transcript row -- would otherwise carry the first failure forever.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  // Compared to the address, so a view with no address at all is not read as a failure.
  const failed = url !== null && failedUrl === url;
  if (url === null || failed) {
    // A message reading "[Image #3] what about this" beside nothing would read as a feed that lost
    // the image, which is a worse thing to be told than that this view cannot load it. A caller
    // whose row names the file itself says so instead, by passing its own `missing`.
    if (missing !== undefined) return <>{missing}</>;
    return (
      <span className={`${CHIP_CLASS}inline-block bg-muted text-muted-foreground`}>
        {failed ? "Image did not load" : "Image"}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpened(true)}
        aria-label={label}
        className={
          (compact ? "shrink-0 rounded-sm " : "max-w-full rounded-md ") +
          "block touch-manipulation overflow-hidden border border-border outline-none transition-[border-color,opacity] hover:border-primary focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary active:opacity-70"
        }
      >
        {/* Bounded in height, not cropped: a tall screenshot stays a recognisable screenshot. */}
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailedUrl(url)}
          className={
            compact ? "block h-[1.4em] max-w-[4em] object-contain" : "block max-h-40 max-w-full object-contain"
          }
        />
      </button>
      {opened ? <ImageLightbox title={title ?? "Image"} url={url} alt={alt} onClose={() => setOpened(false)} /> : null}
    </>
  );
}

/** A picture somebody put into a message, addressed by where its block sits in the event. */
export function EventImageBlock({
  ctx,
  eventIndex,
  blockIndex,
  alt = "Image from this message",
  compact = false,
}: {
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
  alt?: string;
  compact?: boolean;
}) {
  const dataSource = useDataSource();
  // A feed read THROUGH this session (a subagent's run) counts its own lines, so an address built
  // from the parent's id would load some other row's picture, or none.
  const url = ctx.rawSource === "addressable" ? dataSource.eventImageUrl(ctx.session, eventIndex, blockIndex) : null;
  return <EventPicture url={url} alt={alt} compact={compact} />;
}

/**
 * A picture a tool call handed to the reader, addressed by its place in that call's file list.
 *
 * The file itself lives on the machine the session runs on rather than in the transcript, so this
 * is the one picture in the feed that can go away while the row naming it stays -- a scratchpad is
 * swept, a branch is switched. Then the row reads as the name it read as before there was a
 * picture to draw, rather than as a chip reporting a failure the reader can do nothing about.
 */
export function EventFileImage({
  ctx,
  eventIndex,
  blockIndex,
  fileIndex,
  name,
  compact = false,
}: {
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
  fileIndex: number;
  /** The file's own name, which is what the reader knows it by. */
  name: string;
  compact?: boolean;
}) {
  const dataSource = useDataSource();
  const url =
    ctx.rawSource === "addressable" ? dataSource.eventFileUrl(ctx.session, eventIndex, blockIndex, fileIndex) : null;
  return (
    <EventPicture
      url={url}
      alt={`${name}, sent to you`}
      title={name}
      label={`Open ${name} larger`}
      // The row prints the file's name whether or not the picture arrives, and the folded header
      // prints it in the call's own label, so a picture that is gone leaves the name behind.
      missing={null}
      compact={compact}
    />
  );
}
