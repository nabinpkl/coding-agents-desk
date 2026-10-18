/**
 * What the held-images store keeps, and what it refuses to keep.
 *
 * The fake below implements the four IndexedDB operations this module uses (open with an
 * upgrade, get, put, delete inside a transaction), so the real code path runs rather than a
 * stand-in for it. jsdom has no IndexedDB of its own, which is why it is installed as a global
 * at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHeldImage,
  clearHeldImages,
  readHeldImages,
  removeHeldImage,
  type HeldImage,
} from "@/features/session-view/composer/hold/heldImagesStore";

type Row = { sessionKey: string; images: unknown[] };

/** One record per session, the shape the store writes. */
function fakeIndexedDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row.sessionKey, row]));
  let failNext = false;

  function complete<T>(result: T, transaction: { error: unknown; onabort: null | (() => void) }): IDBRequest<T> {
    const request = { result, error: null } as IDBRequest<T>;
    // Real IndexedDB answers on a later task; a microtask is close enough to keep the
    // read-modify-write in this module under test rather than accidentally synchronous.
    queueMicrotask(() => {
      try {
        request.onsuccess?.(new Event("success") as never);
      } catch (error) {
        // A throw inside a request's success handler ABORTS the transaction in a browser.
        // Modelling that matters here: a refused write would otherwise leave the store's
        // promise unsettled, and the test would wait out a timeout instead of seeing the refusal.
        transaction.error = error;
        transaction.onabort?.();
      }
    });
    return request;
  }

  function newTransaction() {
    const transaction = {
      objectStore: () => ({
        get: (key: string) => complete(rows.get(key), transaction),
        put: (row: Row) => {
          if (failNext) {
            // A browser reports a refused write on a LATER task: `put` answers with a request
            // that errors, the transaction aborts, and nothing throws into the caller's
            // handler. Modelling it as a synchronous throw would hide the ordering the module
            // relies on -- it installs its abort handler after issuing the write.
            const request = {
              result: undefined,
              error: new DOMException("quota", "QuotaExceededError"),
            } as unknown as IDBRequest<string>;
            queueMicrotask(() => {
              transaction.error = request.error;
              request.onerror?.(new Event("error") as never);
              transaction.onabort?.();
            });
            return request;
          }
          rows.set(row.sessionKey, row);
          return complete(row.sessionKey, transaction);
        },
        delete: (key: string) => {
          rows.delete(key);
          return complete(undefined, transaction);
        },
      }),
      oncomplete: null as null | (() => void),
      onabort: null as null | (() => void),
      error: null as unknown,
    };
    // IndexedDB completes after the last request in the transaction, which for this module is
    // always the write issued inside the get's success handler. A task rather than a microtask,
    // so a request that already failed can abort the transaction first: a browser never
    // completes a transaction that carried an errored request, and a microtask here would let
    // completion win the race and read as a successful write.
    setTimeout(() => {
      if (transaction.error === null) transaction.oncomplete?.();
      else transaction.onabort?.();
    }, 0);
    return transaction;
  }

  const database = {
    objectStoreNames: { contains: () => true },
    transaction: newTransaction,
  };

  return {
    factory: {
      open: () => {
        const request = {
          result: database,
          error: null,
          onsuccess: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          onblocked: null as null | (() => void),
          onerror: null as null | (() => void),
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    } as unknown as IDBFactory,
    rows,
    refuseNextWrite() {
      failNext = true;
    },
  };
}

function png(name = "shot.png", bytes = "bytes"): File {
  return new File([bytes], name, { type: "image/png" });
}

let fake: ReturnType<typeof fakeIndexedDb>;

beforeEach(() => {
  fake = fakeIndexedDb();
  vi.stubGlobal("indexedDB", fake.factory);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the held-images store", () => {
  it("reads back an appended image, its bytes intact", async () => {
    const blob = png();
    const held = await appendHeldImage("opencode/s1", { name: "shot.png", mime: "image/png", blob });
    expect(held.id).toBe(1);
    const read = await readHeldImages("opencode/s1");
    expect(read).toHaveLength(1);
    expect(read[0]?.name).toBe("shot.png");
    // The Blob itself, not a copy of its name: this is the bytes a later send reads.
    expect(read[0]?.blob).toBe(blob);
  });

  it("allocates ids beside the ones already stored", async () => {
    await appendHeldImage("opencode/s1", { name: "a.png", mime: "image/png", blob: png("a.png") });
    const second = await appendHeldImage("opencode/s1", { name: "b.png", mime: "image/png", blob: png("b.png") });
    expect(second.id).toBe(2);
    const third = await appendHeldImage("opencode/s1", { name: "c.png", mime: "image/png", blob: png("c.png") });
    expect(third.id).toBe(3);
  });

  it("keeps one session's images out of another's", async () => {
    await appendHeldImage("opencode/s1", { name: "a.png", mime: "image/png", blob: png("a.png") });
    await appendHeldImage("opencode/s2", { name: "b.png", mime: "image/png", blob: png("b.png") });
    expect((await readHeldImages("opencode/s1")).map((image) => image.name)).toEqual(["a.png"]);
    expect((await readHeldImages("opencode/s2")).map((image) => image.name)).toEqual(["b.png"]);
    expect(await readHeldImages("opencode/nope")).toEqual([]);
  });

  it("forgets one image and then the rest, leaving the session empty", async () => {
    await appendHeldImage("opencode/s1", { name: "a.png", mime: "image/png", blob: png("a.png") });
    await appendHeldImage("opencode/s1", { name: "b.png", mime: "image/png", blob: png("b.png") });
    await removeHeldImage("opencode/s1", 1);
    expect((await readHeldImages("opencode/s1")).map((image) => image.name)).toEqual(["b.png"]);
    await clearHeldImages("opencode/s1");
    expect(await readHeldImages("opencode/s1")).toEqual([]);
  });

  it("keeps the other images when a removal matches nothing", async () => {
    // The bug this guards: a removal that changed nothing used to take the "drop the record"
    // path and take every other staged image with it. Reachable whenever an id is not in the
    // store -- an image the browser refused to hold, or one already removed.
    await appendHeldImage("opencode/s1", { name: "a.png", mime: "image/png", blob: png("a.png") });
    await appendHeldImage("opencode/s1", { name: "b.png", mime: "image/png", blob: png("b.png") });
    await removeHeldImage("opencode/s1", 99);
    expect((await readHeldImages("opencode/s1")).map((image) => image.name)).toEqual(["a.png", "b.png"]);
  });

  it("drops one unusable stored image and keeps the rest", async () => {
    // A hand-edited or half-written record: the array is there, one entry is not a Blob.
    const stored: HeldImage[] = [
      { id: 1, name: "good.png", mime: "image/png", blob: png("good.png"), addedAt: 1 },
      { id: 2, name: "bad.png", mime: "image/png", blob: "not a blob" as unknown as Blob, addedAt: 2 },
      { id: 3, name: "also-good.png", mime: "image/png", blob: png("also-good.png"), addedAt: 3 },
    ];
    vi.stubGlobal("indexedDB", fakeIndexedDb([{ sessionKey: "opencode/s1", images: stored }]).factory);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = await readHeldImages("opencode/s1");
    expect(read.map((image) => image.name)).toEqual(["good.png", "also-good.png"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("answers empty where the stored shape is not a list at all", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDb([{ sessionKey: "opencode/s1", images: { nope: true } as never }]).factory);
    expect(await readHeldImages("opencode/s1")).toEqual([]);
  });

  it("refuses rather than swallowing a browser that will not store", async () => {
    fake.refuseNextWrite();
    await expect(appendHeldImage("opencode/s1", { name: "a.png", mime: "image/png", blob: png() })).rejects.toThrow();
  });

  it("answers empty where this browser has no IndexedDB at all", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(readHeldImages("opencode/s1")).rejects.toThrow(/no IndexedDB/);
  });
});
