// RFC 6184 H.264 RTP packetization, mode 1: the one piece of glue between our
// encoder's Annex-B access units and werift's RTP track.
//
// Deliberately mechanical. It makes no timing, pacing, or drop decisions; it
// only reframes bytes: a NALU that fits in one packet ships as a single NAL
// unit packet, a bigger one is fragmented as FU-A. werift owns everything with
// judgment in it (SRTP, sequence numbers on the wire, feedback, connectivity).

import { splitAnnexB } from "@/http/tile-codec/annexB";

export interface H264Payload {
  payload: Uint8Array;
  /** True on the access unit's final packet; becomes the RTP marker bit. */
  last: boolean;
}

/**
 * One access unit to RTP payloads. `maxPayload` leaves room for RTP, SRTP and
 * UDP overhead inside a 1500 MTU.
 */
export function packetizeH264(accessUnit: Uint8Array, maxPayload = 1200): H264Payload[] {
  if (!Number.isInteger(maxPayload) || maxPayload < 3) {
    throw new RangeError("H.264 RTP payload ceiling must be an integer of at least 3 bytes");
  }
  const payloads: H264Payload[] = [];
  const units = splitAnnexB(accessUnit);
  for (const nalu of units) {
    if (nalu.length <= maxPayload) {
      payloads.push({ payload: nalu, last: false });
      continue;
    }
    // FU-A: indicator carries the original NRI, header carries the type with
    // start and end bits on the first and last fragment.
    const indicator = (nalu[0]! & 0x60) | 28;
    const type = nalu[0]! & 0x1f;
    let offset = 1;
    while (offset < nalu.length) {
      const room = maxPayload - 2;
      const end = Math.min(offset + room, nalu.length);
      const first = offset === 1;
      const final = end === nalu.length;
      const fragment = new Uint8Array(2 + (end - offset));
      fragment[0] = indicator;
      fragment[1] = (first ? 0x80 : 0) | (final ? 0x40 : 0) | type;
      fragment.set(nalu.subarray(offset, end), 2);
      payloads.push({ payload: fragment, last: false });
      offset = end;
    }
  }
  if (payloads.length > 0) payloads[payloads.length - 1]!.last = true;
  return payloads;
}
