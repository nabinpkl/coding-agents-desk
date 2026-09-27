/**
 * Images held for an opencode send: picked Blobs stay Blobs until the send reads them, and the
 * strip shows object URLs that die with the image.
 *
 * jsdom holds no object URLs, so the test stands in for them: what matters here is the hold,
 * the refusal, and the removal -- the browser owns the URL part.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSendAttachments } from "@/features/session-view/composer/useSendAttachments";

function png(name = "shot.png"): File {
  return new File(["bytes"], name, { type: "image/png" });
}

describe("useSendAttachments", () => {
  it("holds a picked image and reads it as wire bytes at send time", async () => {
    const create = vi.fn(() => "blob:1");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: create, revokeObjectURL: revoke });
    try {
      const { result } = renderHook(() => useSendAttachments());
      await act(async () => {
        result.current.attach([png()]);
      });
      expect(result.current.images).toHaveLength(1);
      expect(result.current.images[0]?.url).toBe("blob:1");
      const wire = await result.current.toWire(result.current.images);
      expect(wire).toEqual([{ data: "Ynl0ZXM=", mime: "image/png", name: "shot.png" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a non-image rather than holding it", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    try {
      const { result } = renderHook(() => useSendAttachments());
      await act(async () => {
        result.current.attach([new File(["x"], "doc.pdf", { type: "application/pdf" })]);
      });
      expect(result.current.images).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes one image and clears the rest", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((_: Blob) => `blob:${Math.random()}`),
      revokeObjectURL: vi.fn(),
    });
    try {
      const { result } = renderHook(() => useSendAttachments());
      await act(async () => {
        result.current.attach([png("a.png"), png("b.png")]);
      });
      const [first] = result.current.images;
      await act(async () => {
        result.current.remove(first!.id);
      });
      expect(result.current.images.map((image) => image.name)).toEqual(["b.png"]);
      await act(async () => {
        result.current.clear();
      });
      expect(result.current.images).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
