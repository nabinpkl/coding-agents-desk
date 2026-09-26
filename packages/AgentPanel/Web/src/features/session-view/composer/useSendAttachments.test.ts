/**
 * Images held for an opencode send: picked Blobs stay Blobs until the send reads them, the
 * strip shows object URLs that die with the image, and both come back after a reload because
 * the store kept the bytes.
 *
 * jsdom holds no object URLs, so the test stands in for them. The store itself is mocked here
 * and tested for real against IndexedDB's shape in `heldImagesStore.test.ts`; what this file
 * owns is the hook: which session's images come back, that a refused store still sends, and
 * that a restored id and a freshly picked one cannot collide.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSendAttachments } from "@/features/session-view/composer/useSendAttachments";

/** The store's contract, in memory: the same four calls, ids allocated beside the stored ones. */
const stored = new Map<string, { id: number; name: string; mime: string; blob: Blob; addedAt: number }[]>();
let refuseWrites = false;

vi.mock("@/features/session-view/composer/heldImagesStore", () => ({
  appendHeldImage: vi.fn(async (key: string, image: { name: string; mime: string; blob: Blob }) => {
    if (refuseWrites) throw new Error("held images: this browser has no IndexedDB");
    const images = stored.get(key) ?? [];
    const held = {
      id: images.reduce((max, held) => Math.max(max, held.id), 0) + 1,
      name: image.name,
      mime: image.mime,
      blob: image.blob,
      addedAt: Date.now(),
    };
    stored.set(key, [...images, held]);
    return held;
  }),
  readHeldImages: vi.fn(async (key: string) => stored.get(key) ?? []),
  removeHeldImage: vi.fn(async (key: string, id: number) => {
    stored.set(key, (stored.get(key) ?? []).filter((image) => image.id !== id));
  }),
  clearHeldImages: vi.fn(async (key: string) => {
    stored.delete(key);
  }),
}));

function png(name = "shot.png"): File {
  return new File(["bytes"], name, { type: "image/png" });
}

/** The URLs this test mints, so a restored image can be told from a fresh one. */
function stubObjectUrls() {
  let minted = 0;
  const create = vi.fn(() => `blob:${++minted}`);
  const revoke = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
}

beforeEach(() => {
  stored.clear();
  refuseWrites = false;
});

describe("useSendAttachments", () => {
  it("holds a picked image and reads it as wire bytes at send time", async () => {
    stubObjectUrls();
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await result.current.attach([png()]);
    });
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]?.url).toBe("blob:1");
    const wire = await result.current.toWire(result.current.images);
    expect(wire).toEqual([{ data: "Ynl0ZXM=", mime: "image/png", name: "shot.png" }]);
  });

  it("refuses a non-image rather than holding it", async () => {
    stubObjectUrls();
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await result.current.attach([new File(["x"], "doc.pdf", { type: "application/pdf" })]);
    });
    expect(result.current.images).toHaveLength(0);
  });

  it("removes one image and clears the rest, in the strip and in the store", async () => {
    stubObjectUrls();
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await result.current.attach([png("a.png"), png("b.png")]);
    });
    const [first] = result.current.images;
    await act(async () => {
      result.current.remove(first!.id);
    });
    expect(result.current.images.map((image) => image.name)).toEqual(["b.png"]);
    expect(stored.get("opencode/s1")?.map((image) => image.name)).toEqual(["b.png"]);
    await act(async () => {
      result.current.clear();
    });
    expect(result.current.images).toHaveLength(0);
    expect(stored.get("opencode/s1")).toBeUndefined();
  });

  it("brings a staged image back after the composer is opened again", async () => {
    const { create, revoke } = stubObjectUrls();
    const first = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await first.result.current.attach([png("kept.png")]);
    });
    // Unmount is the reload as far as this browser is concerned: the bytes are in the store,
    // and the object URL that showed them died with the page.
    first.unmount();
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:1");

    const second = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current.images.map((image) => image.name)).toEqual(["kept.png"]);
    // A NEW url, minted from the stored Blob, so the old dead one is not what comes back.
    expect(create).toHaveBeenCalledTimes(2);
    expect(second.result.current.images[0]?.url).toBe("blob:2");
  });

  it("does not show one session's staged images on another", async () => {
    stubObjectUrls();
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useSendAttachments(key),
      { initialProps: { key: "opencode/s1" } },
    );
    await act(async () => {
      await result.current.attach([png("mine.png")]);
    });
    expect(result.current.images).toHaveLength(1);

    await act(async () => {
      rerender({ key: "opencode/s2" });
      await Promise.resolve();
    });
    expect(result.current.images).toHaveLength(0);
  });

  it("keeps the image sendable when the browser refuses to store it", async () => {
    refuseWrites = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubObjectUrls();
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await result.current.attach([png()]);
    });
    // Storage refused, the hold did not: the image is in the strip and still sends. What is lost
    // is only surviving a reload, and that was said out loud rather than left to be discovered.
    expect(result.current.images).toHaveLength(1);
    expect(await result.current.toWire(result.current.images)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it("re-mints a restored strip's ids beside the stored ones rather than over them", async () => {
    stored.set("opencode/s1", [{
      id: 4,
      name: "old.png",
      mime: "image/png",
      blob: png("old.png"),
      addedAt: 1,
    }]);
    stubObjectUrls();
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.attach([png("new.png")]);
    });
    // Ids 4 and 5, not 1 and 2: removing the new one must not remove the old one.
    expect(result.current.images.map((image) => [image.id, image.name])).toEqual([
      [4, "old.png"],
      [5, "new.png"],
    ]);
  });
});
