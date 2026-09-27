/**
 * Images held for a send the panel owns, rather than a box a pane owns.
 *
 * The tmux band's images live in Claude's composer and are numbered by it; an opencode session
 * has no pane, so what the reader picks stays here until the send carries it. Each image keeps
 * its Blob for the upload and an object URL for the strip, and both die with the image: sent,
 * removed, or unmounted. Non-image drops are refused at the door rather than filtered later,
 * so a PDF never sits in the strip looking sendable.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerImage } from "@/features/cli-input/tmuxComposerHandle";
import { base64FromBlob } from "@/features/activity-feed/data-source/layers/SidecarComposers";

export interface SendableImage extends ComposerImage {
  blob: Blob;
  name: string;
  url: string;
}

export interface SendAttachment {
  data: string;
  mime: string;
  name: string;
}

export function useSendAttachments() {
  const [images, setImages] = useState<readonly SendableImage[]>([]);
  const nextId = useRef(1);
  // Every URL ever minted, revoked once at unmount. Removals revoke eagerly beside this; a
  // second revoke is a no-op, while revoking on every `images` change would pull the URLs out
  // from under the pictures still in the strip.
  const minted = useRef<Set<string>>(new Set());
  useEffect(() => {
    const held = minted.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  const attach = useCallback((files: readonly File[]) => {
    const picked = files.filter((file) => file.type.startsWith("image/"));
    if (picked.length === 0) return;
    setImages((current) => [
      ...current,
      ...picked.map((blob) => {
        const id = nextId.current;
        nextId.current += 1;
        const url = URL.createObjectURL(blob);
        minted.current.add(url);
        return {
          id,
          blob,
          name: blob.name || `image-${id}.png`,
          url,
        };
      }),
    ]);
  }, []);

  const remove = useCallback((id: number) => {
    setImages((current) => {
      const leaving = current.find((image) => image.id === id);
      if (leaving) URL.revokeObjectURL(leaving.url);
      return current.filter((image) => image.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.url);
      return [];
    });
  }, []);

  /**
   * The wire form, read at send time rather than held: base64 inflates a photo by a third, and
   * holding both forms doubles what the strip already shows. Sent alongside the text in the
   * same request, because a created-but-imageless turn cannot be amended afterwards.
   */
  const toWire = useCallback(async (held: readonly SendableImage[]): Promise<SendAttachment[]> => {
    return Promise.all(
      held.map(async (image) => ({
        data: await base64FromBlob(image.blob),
        mime: image.blob.type || "image/png",
        name: image.name,
      })),
    );
  }, []);

  return { images, attach, remove, clear, toWire };
}
