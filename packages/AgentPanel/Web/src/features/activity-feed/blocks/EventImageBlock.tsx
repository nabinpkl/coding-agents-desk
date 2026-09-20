import { useState } from "react";
import { useDataSource } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import { CHIP_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { ImageLightbox } from "@/features/image-viewer/ImageLightbox";

/**
 * A picture somebody put into a message, as a thumbnail that opens larger.
 *
 * The thumbnail is the whole control, the way it is in the composer's strip: the large target
 * opens it, and there is nothing else to do with a picture that has already been sent.
 *
 * Where there is no picture to show it says so rather than disappearing. A message reading
 * "[Image #3] what about this" beside nothing would read as a feed that lost the image, which is a
 * worse thing to be told than that this view cannot load it.
 */
export function EventImageBlock({
  ctx,
  eventIndex,
  blockIndex,
}: {
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
}) {
  const dataSource = useDataSource();
  const [opened, setOpened] = useState(false);
  const [failed, setFailed] = useState(false);
  // A feed read THROUGH this session (a subagent's run) counts its own lines, so an address built
  // from the parent's id would load some other row's picture, or none.
  const url = ctx.rawSource === "addressable"
    ? dataSource.eventImageUrl(ctx.session, eventIndex, blockIndex)
    : null;

  if (url === null || failed) {
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
        aria-label="Open image larger"
        className="block max-w-full touch-manipulation overflow-hidden rounded-md border border-border outline-none transition-[border-color,opacity] hover:border-primary focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary active:opacity-70"
      >
        {/* Bounded in height, not cropped: a tall screenshot stays a recognisable screenshot. */}
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="block max-h-40 max-w-full object-contain"
        />
      </button>
      {opened ? (
        <ImageLightbox
          title="Image"
          url={url}
          alt="Image from this message"
          onClose={() => setOpened(false)}
        />
      ) : null}
    </>
  );
}
