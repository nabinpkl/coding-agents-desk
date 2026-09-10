import { describe, expect, test } from "bun:test";
import { gridEncoderSourceMetadata } from "@/http/tile-encoder/webrtcTileMetadata";

describe("gridEncoderSourceMetadata", () => {
  test("keeps logical input points separate from encoded pixel dimensions", () => {
    expect(gridEncoderSourceMetadata({
      type: "open",
      width: 2340,
      height: 1518,
      desktopControlVersion: 2,
      inputBounds: { x: 100, y: 20, w: 1170, h: 759 },
      cursor: { x: 584.5, y: 379 },
    })).toEqual({
      width: 1170,
      height: 759,
      cursor: { x: 584.5, y: 379 },
      desktopControlVersion: 2,
    });
  });

  test("rejects malformed or out-of-bounds opening metadata", () => {
    expect(gridEncoderSourceMetadata({ type: "status" })).toBeNull();
    expect(gridEncoderSourceMetadata({
      type: "open",
      inputBounds: { w: 1170, h: 759 },
      cursor: { x: 1170, y: 10 },
    })).toBeNull();
    expect(gridEncoderSourceMetadata({
      type: "open",
      inputBounds: { w: Number.NaN, h: 759 },
      cursor: { x: 10, y: 10 },
    })).toBeNull();
  });
});
