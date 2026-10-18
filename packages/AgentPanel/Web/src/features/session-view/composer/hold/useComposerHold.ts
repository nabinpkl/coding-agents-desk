/**
 * What a composer is holding for a send that has not happened yet, and the two holds it can be:
 * staged images and unsent text.
 *
 * Both were React state alone, so a reload, a discarded phone webview or a Vite save threw away
 * a photo or a half-written sentence somebody had already chosen to send. Both are now keyed by
 * the session and remembered in this browser, and both are keyed because that is what they belong
 * to: switching sessions must not carry another thread's photos or words into this one, and
 * coming back to a session must find what was left in it.
 *
 * The two are stored differently because they are different sizes, and the difference is load
 * bearing rather than tidy:
 *
 * - Images go to IndexedDB (`heldImagesStore`). An 8 MiB photo base64s to a third more than
 *   that and localStorage's whole budget is a few MiB, so a Blob has to be stored as a Blob.
 * - Text goes to localStorage, one key per session. It is small, and reading it back
 *   SYNCHRONOUSLY is what lets the field open already holding the sentence instead of flashing
 *   empty and then refilling, which for a text field is the whole feature.
 *
 * Neither belongs to the sidecar. It owns sessions, not input somebody is still deciding whether
 * to send, and the send already carries both.
 *
 * A refusal from storage never costs the reader their input. The hold is in memory either way and
 * still sends; what a refusal costs is surviving a reload, and that is logged once so the
 * difference between two machines is discoverable rather than silent.
 *
 * The mirrored transports are deliberately NOT here: a tmux pane and a desktop window each own
 * their own draft, keep it across a reload already, and must not be second-guessed by a copy.
 */

import { useCallback, useRef, useState } from "react";
import type { ComposerImage } from "@/features/cli-input/tmuxComposerHandle";
import { base64FromBlob } from "@/features/activity-feed/data-source/layers/SidecarComposers";
import {
  appendHeldImage,
  clearHeldImages,
  readHeldImages,
  removeHeldImage,
} from "@/features/session-view/composer/hold/heldImagesStore";
import { useCommitToRef, useLatestRef } from "@/hooks/useLatestRef";
import { useSubscription } from "@/hooks/useSubscription";

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
  console.warn(`composer hold: ${action} failed, so this will not survive a reload`, error);
}

export function useSendAttachments(sessionKey: string) {
  /**
   * The strip is held WITH the key it belongs to, rather than as a bare array. A session change
   * is then adjusted during render instead of in an effect: the previous session's photos are
   * never committed even for one frame, which matters because they are somebody's pictures and
   * the field beside them is a send.
   */
  const [strip, setStrip] = useState<{ key: string; images: readonly SendableImage[] }>({
    key: sessionKey,
    images: [],
  });
  if (strip.key !== sessionKey) setStrip({ key: sessionKey, images: [] });
  const images = strip.key === sessionKey ? strip.images : [];
  /**
   * The strip as last committed, so a removal can find the URL to revoke without reading a
   * closure that may predate the render which drew it.
   */
  const held = useLatestRef<readonly SendableImage[]>(images);
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
  // The key in a ref as well as the subscription's key, so a write that lands after the reader
  // has moved to another session stores against the session it was picked for.
  const keyRef = useLatestRef(sessionKey);

  // The strip is already this session's and empty, thanks to the render-time adjustment above;
  // all that is left is to read this session's own images back into it, and to let their URLs go
  // when the session is left.
  useSubscription(sessionKey, () => {
    let current = true;
    void readHeldImages(sessionKey).then(
      (restored) => {
        if (!current || keyRef.current !== sessionKey) return;
        setStrip({
          key: sessionKey,
          images: restored.map((image) => {
            const url = URL.createObjectURL(image.blob);
            minted.current.add(url);
            return { id: image.id, blob: image.blob, name: image.name, url };
          }),
        });
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
  });

  const attach = useCallback(
    async (files: readonly File[]) => {
      const picked = files.filter((file) => file.type.startsWith("image/"));
      if (picked.length === 0) return;
      const key = keyRef.current;
      const staged = await Promise.all(
        picked.map(async (blob) => {
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
        }),
      );
      // The reader moved on while the store was answering. These belong to the session they were
      // picked for, which already read its own strip, so they are dropped rather than shown here;
      // their stored copies stay for when that session is opened again.
      if (keyRef.current !== key) {
        for (const image of staged) URL.revokeObjectURL(image.url);
        return;
      }
      for (const image of staged) minted.current.add(image.url);
      setStrip((current) => ({ key, images: [...current.images, ...staged] }));
    },
    [keyRef],
  );

  const remove = useCallback(
    (id: number) => {
      // Both effects live here rather than inside the state updater: an updater is meant to be
      // pure, and React may run it more than once for one change.
      setStrip((current) => ({
        key: current.key,
        images: current.images.filter((image) => image.id !== id),
      }));
      for (const image of held.current) {
        if (image.id !== id) continue;
        URL.revokeObjectURL(image.url);
        void removeHeldImage(keyRef.current, id).catch((error: unknown) =>
          reportStorageRefusal("forgetting a staged image", error),
        );
      }
    },
    [held, keyRef],
  );

  /** Forgets the whole strip, in memory and in the store: a send, or a discarded draft. */
  const clear = useCallback(() => {
    setStrip((current) => (current.images.length === 0 ? current : { key: current.key, images: [] }));
    for (const image of held.current) URL.revokeObjectURL(image.url);
    void clearHeldImages(keyRef.current).catch((error: unknown) =>
      reportStorageRefusal("forgetting staged images", error),
    );
  }, [held, keyRef]);

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

const DRAFT_KEY_PREFIX = "agent-panel.composer-draft.";

function draftStorageKey(sessionKey: string): string {
  // One key per session rather than one map, so a keystroke rewrites this session's draft and
  // nothing else. A map would make every character pay for every other session's text.
  return `${DRAFT_KEY_PREFIX}${sessionKey}`;
}

function readStoredDraft(sessionKey: string): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = window.localStorage.getItem(draftStorageKey(sessionKey));
    // Checked rather than cast: a hand-edited or stale value falls back to an empty field
    // rather than rendering whatever shape arrived as the reader's words.
    return typeof raw === "string" ? raw : "";
  } catch {
    return ""; // storage disabled, or a private window that throws on read
  }
}

function writeStoredDraft(sessionKey: string, text: string): void {
  try {
    // An empty draft is a deleted key rather than an empty string, so a session that was never
    // typed into leaves nothing behind for the quota and nothing to explain in a storage panel.
    if (text) window.localStorage.setItem(draftStorageKey(sessionKey), text);
    else window.localStorage.removeItem(draftStorageKey(sessionKey));
  } catch (error) {
    reportStorageRefusal("storing the draft", error);
  }
}

/**
 * The composer's own text: what the reader typed for a send the panel carries itself, remembered
 * across a reload.
 *
 * The setter is the ONLY way to change it, and it writes through to storage itself, so the two
 * cannot drift. That is what makes the send path's existing `setDraft("")` clear the remembered
 * copy too, with no second call to remember: a successful send empties the field and the stored
 * draft together, and a refused one leaves both, because the catch never calls the setter.
 *
 * Not debounced. A debounce would leave the last few characters of a sentence in memory only,
 * and a reload inside that window would lose exactly the tail somebody had just typed, which is
 * the case this exists for. The write is one small key per keystroke, the same shape the panel's
 * other remembered values already use.
 */
export function useComposerDraft(
  sessionKey: string,
): [string, (value: string | ((current: string) => string)) => void] {
  // Held WITH its key, for the reason the images are: a session change is adjusted during
  // render rather than in an effect, so the previous session's sentence is never committed even
  // for a frame beside a field that sends. React re-runs this component with the new state
  // before it renders anything, so the stale pass below never reaches the screen.
  const [held, setHeld] = useState(() => ({ key: sessionKey, draft: readStoredDraft(sessionKey) }));
  if (held.key !== sessionKey) setHeld({ key: sessionKey, draft: readStoredDraft(sessionKey) });
  // The key in a ref as well, so a keystroke that lands after the reader has moved to another
  // session is stored against the session it was typed for.
  const keyRef = useLatestRef(sessionKey);
  // The current draft, so the updater form a `useState` setter accepts can be resolved here
  // rather than only a plain value. The transport handover uses it to keep whichever side
  // already holds text.
  const draftRef = useRef(held.draft);
  useCommitToRef(draftRef, held.draft);
  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => {
      const next = typeof value === "function" ? value(draftRef.current) : value;
      draftRef.current = next;
      setHeld((current) => ({ key: current.key, draft: next }));
      writeStoredDraft(keyRef.current, next);
    },
    [keyRef],
  );
  return [held.draft, setDraft];
}
