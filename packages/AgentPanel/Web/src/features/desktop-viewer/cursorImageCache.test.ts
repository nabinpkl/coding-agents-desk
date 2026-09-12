import { describe, expect, it } from "vitest";
import type { WebrtcCursorImage } from "@agentdesk/agent-feed-wire";
import { CursorImageCache } from "@/features/desktop-viewer/cursorImageCache";

function image(hash: string, png?: string): WebrtcCursorImage {
  return {
    type: "cursor-image",
    hash,
    png,
    hotspotXFrac: 0,
    hotspotYFrac: 0,
    widthPoints: 16,
    heightPoints: 24,
    hidden: false,
    cursorKind: "arrow",
  };
}

describe("CursorImageCache", () => {
  it("decodes a hash once and serves later hash-only cursor changes", () => {
    const cache = new CursorImageCache();
    expect(cache.resolve(image("arrow", "AQID"))?.source).toBe("data:image/png;base64,AQID");
    expect(cache.resolve(image("arrow"))?.source).toBe("data:image/png;base64,AQID");
  });

  it("evicts the oldest image at its bound", () => {
    const cache = new CursorImageCache(2);
    cache.resolve(image("one", "AQ=="));
    cache.resolve(image("two", "Ag=="));
    cache.resolve(image("three", "Aw=="));
    expect(cache.resolve(image("one"))).toBeNull();
    expect(cache.resolve(image("two"))).not.toBeNull();
  });
});
