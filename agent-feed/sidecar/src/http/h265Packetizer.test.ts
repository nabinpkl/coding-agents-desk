import { describe, expect, test } from "bun:test";
import { packetizeH265 } from "./h265Packetizer.ts";

function hevcHeader(type: number, layerId = 0, temporalIdPlusOne = 1, forbidden = 0): number[] {
  const packed = (forbidden << 15) | (type << 9) | (layerId << 3) | temporalIdPlusOne;
  return [packed >>> 8, packed & 0xff];
}

function annexB(...units: number[][]): Uint8Array {
  return new Uint8Array(units.flatMap((unit) => [0, 0, 0, 1, ...unit]));
}

describe("packetizeH265 RFC 7798 SRST", () => {
  test("sends exactly one fitting NAL unit with its header unchanged", () => {
    const nalu = [...hevcHeader(19), 0xaa, 0xbb];
    const payloads = packetizeH265(annexB(nalu));

    expect(payloads).toHaveLength(1);
    expect([...payloads[0]!.payload]).toEqual(nalu);
    expect(payloads[0]!.last).toBe(true);
  });

  test("matches the RFC 7798 Figure 7 AP layout without DONL or DOND", () => {
    const vps = [...hevcHeader(32), 0xaa];
    const sps = [...hevcHeader(33), 0xbb, 0xcc];
    const payloads = packetizeH265(annexB(vps, sps), 1200);

    // Type 48 header, then a 16-bit network-order size and complete NAL unit
    // for each aggregation unit. This is also the layout emitted by Pion RTP.
    expect([...payloads[0]!.payload]).toEqual([
      0x60, 0x01,
      0x00, 0x03, ...vps,
      0x00, 0x04, ...sps,
    ]);
    expect(payloads[0]!.last).toBe(true);
  });

  test("AP header carries the forbidden OR and minimum LayerId and TID", () => {
    const first = [...hevcHeader(32, 7, 3, 1), 0xaa];
    const second = [...hevcHeader(33, 2, 1), 0xbb];
    const [packet] = packetizeH265(annexB(first, second));
    const expectedHeader = (1 << 15) | (48 << 9) | (2 << 3) | 1;

    expect(packet!.payload[0]).toBe(expectedHeader >>> 8);
    expect(packet!.payload[1]).toBe(expectedHeader & 0xff);
  });

  test("matches the RFC FU header layout and reconstructs the original NAL", () => {
    const nalu = [...hevcHeader(19, 0, 1), 1, 2, 3, 4, 5, 6, 7];
    const payloads = packetizeH265(annexB(nalu), 6);

    expect(payloads.map(({ payload }) => [...payload])).toEqual([
      [0x62, 0x01, 0x80 | 19, 1, 2, 3],
      [0x62, 0x01, 19, 4, 5, 6],
      [0x62, 0x01, 0x40 | 19, 7],
    ]);
    const rebuilt = [
      ...hevcHeader(19, 0, 1),
      ...payloads.flatMap(({ payload }) => [...payload.subarray(3)]),
    ];
    expect(rebuilt).toEqual(nalu);
    expect(payloads.map(({ last }) => last)).toEqual([false, false, true]);
  });

  test("preserves LayerId and TID through every FU payload header", () => {
    const nalu = [...hevcHeader(20, 37, 5), ...Array.from({ length: 20 }, (_, index) => index)];
    const payloads = packetizeH265(annexB(nalu), 8);
    const expectedHeader = [...hevcHeader(49, 37, 5)];

    for (const { payload } of payloads) {
      expect([...payload.subarray(0, 2)]).toEqual(expectedHeader);
      expect(payload.length).toBeLessThanOrEqual(8);
    }
  });

  test("uses singles when two NAL units cannot share one AP", () => {
    const first = [...hevcHeader(32), 1, 2, 3];
    const second = [...hevcHeader(1), 4, 5, 6];
    const payloads = packetizeH265(annexB(first, second), 6);

    expect(payloads.map(({ payload }) => [...payload])).toEqual([first, second]);
    expect(payloads.map(({ last }) => last)).toEqual([false, true]);
  });

  test("marks only the final packet across AP, FU and single payloads", () => {
    const vps = [...hevcHeader(32), 1];
    const sps = [...hevcHeader(33), 2];
    const large = [...hevcHeader(19), ...Array.from({ length: 15 }, () => 3)];
    const suffix = [...hevcHeader(40), 4];
    const payloads = packetizeH265(annexB(vps, sps, large, suffix), 12);

    expect(payloads.filter(({ last }) => last)).toHaveLength(1);
    expect(payloads.at(-1)!.last).toBe(true);
    expect([...payloads.at(-1)!.payload]).toEqual(suffix);
  });

  test("rejects malformed input and unusable payload ceilings", () => {
    expect(() => packetizeH265(annexB([...hevcHeader(19)]))).toThrow(TypeError);
    expect(() => packetizeH265(annexB([0x26, 0x00, 1]))).toThrow(/temporal_id_plus1/);
    expect(() => packetizeH265(annexB([...hevcHeader(49), 1]))).toThrow(/reserved/);
    expect(() => packetizeH265(annexB([...hevcHeader(19), 1]), 3)).toThrow(RangeError);
  });
});
