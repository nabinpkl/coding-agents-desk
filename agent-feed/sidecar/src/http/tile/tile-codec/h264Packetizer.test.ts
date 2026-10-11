import { describe, expect, test } from "bun:test";
import { packetizeH264 } from "@/http/tile/tile-codec/h264Packetizer";

function annexB(...units: number[][]): Uint8Array {
  const parts: number[] = [];
  for (const unit of units) parts.push(0, 0, 0, 1, ...unit);
  return new Uint8Array(parts);
}

describe("packetizeH264", () => {
  test("a small NALU ships whole, and the AU's final packet carries the marker", () => {
    const payloads = packetizeH264(annexB([0x67, 1], [0x65, 2, 3]));
    expect(payloads).toHaveLength(2);
    expect([...payloads[0]!.payload]).toEqual([0x67, 1]);
    expect(payloads[0]!.last).toBe(false);
    expect(payloads[1]!.last).toBe(true);
  });

  test("a large NALU fragments as FU-A with start and end bits", () => {
    const big = [0x65, ...Array.from({ length: 2500 }, (_, i) => i % 251)];
    const payloads = packetizeH264(annexB(big), 1200);
    expect(payloads.length).toBe(3);
    const type = 0x65 & 0x1f;
    // Indicator keeps the NRI bits, type 28.
    expect(payloads[0]!.payload[0]).toBe((0x65 & 0x60) | 28);
    expect(payloads[0]!.payload[1]).toBe(0x80 | type);
    expect(payloads[1]!.payload[1]).toBe(type);
    expect(payloads[2]!.payload[1]).toBe(0x40 | type);
    // Reassembly: header byte plus fragments equals the original NALU.
    const reassembled = [
      0x65,
      ...payloads.flatMap((p) => [...p.payload.subarray(2)]),
    ];
    expect(reassembled).toEqual(big);
  });

  test("each fragment stays within the payload budget", () => {
    const big = [0x61, ...Array.from({ length: 5000 }, () => 7)];
    for (const { payload } of packetizeH264(annexB(big), 1200)) {
      expect(payload.length).toBeLessThanOrEqual(1200);
    }
  });

  test("rejects a payload ceiling that cannot carry an FU-A byte", () => {
    expect(() => packetizeH264(annexB([0x65, 1, 2]), 2)).toThrow(RangeError);
  });
});
