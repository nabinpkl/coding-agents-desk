import { describe, expect, test } from "bun:test";
import { splitAnnexB } from "@/http/tile-codec/annexB";

describe("splitAnnexB", () => {
  test("splits four-byte start codes into bare NAL units", () => {
    const data = new Uint8Array([
      0, 0, 0, 1, 0x67, 1, 2,
      0, 0, 0, 1, 0x68, 3,
      0, 0, 0, 1, 0x65, 4, 5, 6,
    ]);

    expect(splitAnnexB(data).map((unit) => [...unit])).toEqual([
      [0x67, 1, 2],
      [0x68, 3],
      [0x65, 4, 5, 6],
    ]);
  });

  test("handles mixed three-byte and four-byte start codes", () => {
    const data = new Uint8Array([0, 0, 1, 0x40, 9, 0, 0, 0, 1, 0x26, 7]);

    expect(splitAnnexB(data).map((unit) => [...unit])).toEqual([
      [0x40, 9],
      [0x26, 7],
    ]);
  });

  test("ignores empty units and data before the first start code", () => {
    const data = new Uint8Array([9, 9, 0, 0, 1, 0, 0, 1, 0x40, 1]);
    expect(splitAnnexB(data).map((unit) => [...unit])).toEqual([[0x40, 1]]);
  });

  test("returns nothing when no start code is present", () => {
    expect(splitAnnexB(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});
