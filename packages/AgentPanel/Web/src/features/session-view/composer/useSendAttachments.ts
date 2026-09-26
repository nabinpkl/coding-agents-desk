/**
 * Images held for a send the panel owns, rather than a box a pane owns.
 *
 * The tmux band's images live in Claude's composer and are numbered by it; an opencode session
 * has no pane, so what the reader picks stays here until the send carries it. Each image keeps
 * its Blob for the upload and an object URL for the strip, and the URL is re-minted from the
 * stored Blob when the session is opened again, so a reload, a discarded phone webview or a
 * Vite save no longer throws away an image somebody chose and had not sent yet. Non-image drops
 * are refused at the door rather than filtered later, so a PDF never sits in the strip looking
 * sendable.
 *
 * Keyed by the session, because that is what a staged image belongs to: switching sessions
 * empties the strip rather than carrying another thread's photos into this one, and coming back
 * finds them. Storage is the browser's own IndexedDB (`heldImagesStore`), never the sidecar: the
 * sidecar owns sessions, not bytes somebody is still deciding whether to send.
 *
 * A refusal from storage never costs the reader the image. The hold is in memory either way and
 * still sends; what a refusal costs is surviving a reload, and that is logged once so the
 * difference between two machines is discoverable rather than silent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerImage } from "@/features/cli-input/tmuxComposerHandle";
import { base64FromBlob } from "@/features/activity-feed/data-source/layers/SidecarComposers";
import {
  appendHeldImage,
  clearHeldImages,
  readHeldImages,
  removeHeldImage,
} from "@/features/session-view/composer/heldImagesStore";

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

/** Logged at most once per reason, so a browser that refuses storage says so without repeating. */
const reported = new Set<string>();

function reportStorageRefusal(action: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  const key = `${action}: ${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`held images: ${action} failed, so this image will not survive a reload`, error);
}

export function useSendAttachments(sessionKey: string) {
  const [images, setImages] = useState<readonly SendableImage[]>([]);
  /**
   * The strip as last committed, so a removal can find the URL to revoke without reading a
   * closure that may predate the render which drew it.
   */
  const held = useRef<readonly SendableImage[]>([]);
  held.current = images;
  /**
   * Every object URL this strip is showing, revoked when the strip empties for any reason: one
   * removed, one sent, the session changed, the component unmounted. A URL is added as soon as
   * it is minted, so there is no window where a live picture is not tracked. Revoking from
   * `images` instead would pull the URLs out from under the pictures still in the strip.
   */
  const minted = useRef<Set<string>>(new Set());
  // Ids for images the browser refused to store, so the strip can still remove them. Negative
  // and counting down, because a stored id is allocated from the stored ones and is always
  // positive: an image held only in memory can never collide with one that was remembered.
  const unstored = useRef(0);
  // The key in a ref as well as the effect's dependency, so a write that lands after the reader
  // has moved to another session stores against the session it was picked for.
  const keyRef = useRef(sessionKey);
  keyRef.current = sessionKey;

  useEffect(() => {
    let current = true;
    // The strip belongs to the session on screen, so it empties on every switch. The identity
    // check keeps that from costing a render on mount, where it is already empty.
    setImages((current) => (current.length === 0 ? current : []));
    void readHeldImages(sessionKey).then(
      (held) => {
        if (!current || keyRef.current !== sessionKey) return;
        setImages(held.map((image) => {
          const url = URL.createObjectURL(image.blob);
          minted.current.add(url);
          return { id: image.id, blob: image.blob, name: image.name, url };
        }));
      },
      (error: unknown) => {
        if (!current) return;
        reportStorageRefusal("reading staged images", error);
      },
    );
    return () => {
      // Runs on a session change and on unmount, and is the one place every URL is revoked.
      current = false;
      for (const url of minted.current) URL.revokeObjectURL(url);
      minted.current.clear();
    };
  }, [sessionKey]);

  const attach = useCallback(async (files: readonly File[]) => {
    const picked = files.filter((file) => file.type.startsWith("image/"));
    if (picked.length === 0) return;
    const key = keyRef.current;
    const staged = await Promise.all(picked.map(async (blob) => {
      const name = blob.name || "image.png";
      const url = URL.createObjectURL(blob);
      try {
        // The id comes back from the store rather than from a counter here: it is allocated
        // beside the ones already stored, so a restored image and a newly picked one cannot land
        // on the same id and remove the wrong photo.
        const held = await appendHeldImage(key, { name, mime: blob.type || "image/png", blob });
        return { id: held.id, blob, name, url };
      } catch (error) {
        reportStorageRefusal("storing a staged image", error);
        // Still staged, still sendable: only its survival across a reload is gone.
        unstored.current += 1;
        return { id: -unstored.current, blob, name, url };
      }
    }));
    // The reader moved on while the store was answering. These belong to the session they were
    // picked for, which already read its own strip, so they are dropped rather than shown here;
    // their stored copies stay for when that session is opened again.
    if (keyRef.current !== key) {
      for (const image of staged) URL.revokeObjectURL(image.url);
      return;
    }
    for (const image of staged) minted.current.add(image.url);
    setImages((currentImages) => [...currentImages, ...staged]);
  }, []);

  const remove = useCallback((id: number) => {
    // Both effects live here rather than inside the state updater: an updater is meant to be
    // pure, and React may run it more than once for one change.
    setImages((current) => current.filter((image) => image.id !== id));
    for (const image of held.current) {
      if (image.id !== id) continue;
      URL.revokeObjectURL(image.url);
      void removeHeldImage(keyRef.current, id).catch(
        (error: unknown) => reportStorageRefusal("forgetting a staged image", error),
      );
    }
  }, []);

  const clear = useCallback(() => {
    setImages((current) => (current.length === 0 ? current : []));
    for (const image of held.current) URL.revokeObjectURL(image.url);
    void clearHeldImages(keyRef.current).catch(
      (error: unknown) => reportStorageRefusal("forgetting staged images", error),
    );
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
