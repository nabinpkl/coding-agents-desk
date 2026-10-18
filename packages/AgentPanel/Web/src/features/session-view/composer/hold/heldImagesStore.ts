/**
 * Images staged in a composer but not yet sent, remembered across a reload, in the browser's
 * own IndexedDB.
 *
 * Why it has to be remembered: a staged image is user input that has not been sent anywhere yet.
 * A reload, a discarded phone webview, or a Vite save threw it away, and the reader's only way
 * back was finding the file again. The sidecar is deliberately NOT the home: it owns sessions,
 * not the bytes somebody is still choosing whether to send, and the send already carries them.
 *
 * Why IndexedDB and not localStorage: an 8 MiB photo base64s to about a third more than that,
 * and a browser's localStorage budget is a few MiB in total. IndexedDB stores a Blob without
 * inflating it, is same-origin (so it follows the reader's browser, which is where an unsent
 * draft belongs), and survives a reload on its own.
 *
 * One record per session, so opening another session cannot show another's staged images and
 * removing one does not rewrite the others. Ids are allocated HERE rather than in the caller,
 * inside the same transaction as the write: a second page's numbering could not collide with
 * these, and the strip's remove(id) keeps naming the same thing after a reload.
 *
 * Every function throws when the browser refuses -- storage disabled, a private window, a quota
 * refusal. The caller keeps the image in memory either way (a staged image is still sendable
 * without storage) and logs the refusal once, so "this will not survive a reload" is
 * discoverable rather than silent.
 */

const DATABASE_NAME = "agent-panel.held-images";
const DATABASE_VERSION = 1;
const STORE = "sessions";

/** One staged image, as it rests in storage. */
export interface HeldImage {
  /** Unique within its session, allocated by {@link appendHeldImage}. */
  id: number;
  name: string;
  mime: string;
  blob: Blob;
  /** Order the strip draws in, and the tiebreak when ids were allocated in a burst. */
  addedAt: number;
}

interface HeldSession {
  sessionKey: string;
  images: HeldImage[];
}

function storage(): IDBFactory | null {
  // Absent in a non-browser render, and refused outright in some embedded webviews. A missing
  // factory is a refusal like any other: the caller keeps the image in memory.
  return globalThis.indexedDB ?? null;
}

/**
 * One open connection per database factory, reused for the life of the page. Weak so a factory
 * that goes away takes its connection with it, and keyed rather than a single module-level
 * promise because a different factory IS a different database: one page holding two is a test,
 * and a promise cached across both would write one test's images into another's storage.
 */
const opening = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

function database(): Promise<IDBDatabase> {
  const factory = storage();
  if (!factory) return Promise.reject(new Error("held images: this browser has no IndexedDB"));
  const already = opening.get(factory);
  if (already) return already;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "sessionKey" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema closes this connection rather than leaving it open
      // against a version this page has not seen; the next call reopens against the new one.
      db.onversionchange = () => {
        db.close();
        opening.delete(factory);
      };
      resolve(db);
    };
    // `blocked` means another tab holds an older version open, so this one will never open.
    // Refusing now is the honest answer; the caller's image is still sendable without storage.
    request.onblocked = () => reject(new Error("held images: another tab is holding the database"));
    request.onerror = () => reject(request.error ?? new Error("held images: the database would not open"));
  });
  // A failed open must not poison every later call with the same rejection, or a reader who
  // frees storage by closing a tab could never stage again in this page.
  pending.catch(() => {
    if (opening.get(factory) === pending) opening.delete(factory);
  });
  opening.set(factory, pending);
  return pending;
}

/**
 * One read-modify-write inside a single transaction, which is what keeps two appends on this
 * page from reading the same highest id. A second TAB can still race that, and its write wins:
 * both tabs are this reader, each strip still holds its own image, and only the remembered copy
 * differs -- so the race costs a duplicate after a reload, never a staged photo.
 */
function mutate<T>(
  sessionKey: string,
  change: (existing: HeldImage[]) => { images: HeldImage[]; answer: T },
): Promise<T> {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        const pending = store.get(sessionKey);
        pending.onsuccess = () => {
          const existing = usableImages((pending.result as { images?: unknown } | undefined)?.images);
          const next = change(existing);
          // An empty list is no record, which is the ONLY thing that deletes one. Deriving the
          // delete from emptiness rather than from what the change asked for means a removal
          // that matched nothing rewrites the same list instead of taking the other images with
          // it -- the one way this could lose a staged photo that was still on screen.
          if (next.images.length === 0) store.delete(sessionKey);
          else store.put({ sessionKey, images: next.images } satisfies HeldSession);
          transaction.oncomplete = () => resolve(next.answer);
          transaction.onabort = () => reject(transaction.error ?? new Error("held images: the write aborted"));
        };
        pending.onerror = () => reject(pending.error ?? new Error("held images: the read failed"));
      }),
  );
}

/**
 * What a stored session is allowed to be. Checked field by field rather than cast: a stale
 * shape must fall back to holding nothing, not become a Blob that is not one and a name that
 * is not a string. A single unusable entry is dropped on its own, because losing one corrupt
 * record is recoverable and losing the other staged photos with it is not.
 */
function usableImages(value: unknown): HeldImage[] {
  if (!Array.isArray(value)) return [];
  const images: HeldImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<HeldImage>;
    if (
      typeof record.id !== "number" ||
      !Number.isSafeInteger(record.id) ||
      typeof record.name !== "string" ||
      !record.name ||
      typeof record.mime !== "string" ||
      !record.mime.startsWith("image/") ||
      typeof record.addedAt !== "number" ||
      !Number.isFinite(record.addedAt) ||
      !(record.blob instanceof Blob)
    ) {
      console.warn("held images: dropping one stored image that is not the shape this expects");
      continue;
    }
    images.push({
      id: record.id,
      name: record.name,
      mime: record.mime,
      blob: record.blob,
      addedAt: record.addedAt,
    });
  }
  return images;
}

/** Everything staged for one session, oldest first. Empty where nothing is stored. */
export async function readHeldImages(sessionKey: string): Promise<HeldImage[]> {
  const db = await database();
  const images = await new Promise<unknown>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const pending = transaction.objectStore(STORE).get(sessionKey);
    pending.onsuccess = () => resolve((pending.result as { images?: unknown } | undefined)?.images);
    pending.onerror = () => reject(pending.error ?? new Error("held images: the read failed"));
  });
  return usableImages(images);
}

/** Stores one image and answers the id it was given, allocated beside the other ids. */
export function appendHeldImage(
  sessionKey: string,
  image: { name: string; mime: string; blob: Blob },
): Promise<HeldImage> {
  return mutate<HeldImage>(sessionKey, (existing) => {
    const highest = existing.reduce((max, held) => Math.max(max, held.id), 0);
    const held: HeldImage = {
      id: highest + 1,
      name: image.name,
      mime: image.mime,
      blob: image.blob,
      addedAt: Date.now(),
    };
    return { images: [...existing, held], answer: held };
  });
}

/**
 * Forgets one image. An id that is not there is not an error and costs nothing: the list comes
 * back the same length, so it is written back unchanged rather than the session being dropped.
 */
export function removeHeldImage(sessionKey: string, id: number): Promise<void> {
  return mutate<void>(sessionKey, (existing) => ({
    images: existing.filter((held) => held.id !== id),
    answer: undefined,
  }));
}

/** Forgets every image staged for one session, which is what a send does. */
export function clearHeldImages(sessionKey: string): Promise<void> {
  return mutate<void>(sessionKey, () => ({ images: [], answer: undefined }));
}
