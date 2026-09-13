// RFC 7798 HEVC RTP packetization for one SRST stream with decoding order
// equal to transmission order. The negotiated sprop-max-don-diff is zero, so
// DONL and DOND are deliberately absent.

import { splitAnnexB } from "@/http/tile-codec/annexB";

const AP_TYPE = 48;
const FU_TYPE = 49;
const PACI_TYPE = 50;
const NAL_HEADER_BYTES = 2;
const FU_HEADER_BYTES = 3;

export interface H265Payload {
  payload: Uint8Array;
  /** True on the access unit's final packet; becomes the RTP marker bit. */
  last: boolean;
}

interface H265NalHeader {
  forbidden: number;
  type: number;
  layerId: number;
  temporalIdPlusOne: number;
}

/** Packetize one Annex-B HEVC access unit according to RFC 7798 sections 4.4 and 5. */
export function packetizeH265(accessUnit: Uint8Array, maxPayload = 1200): H265Payload[] {
  if (!Number.isInteger(maxPayload) || maxPayload < FU_HEADER_BYTES + 1) {
    throw new RangeError("HEVC RTP payload ceiling must be an integer of at least 4 bytes");
  }

  const payloads: H265Payload[] = [];
  let aggregation: Uint8Array[] = [];
  const flushAggregation = () => {
    if (aggregation.length === 1) {
      payloads.push({ payload: aggregation[0]!, last: false });
    } else if (aggregation.length > 1) {
      payloads.push({ payload: aggregate(aggregation), last: false });
    }
    aggregation = [];
  };

  for (const nalu of splitAnnexB(accessUnit)) {
    const header = parseNalHeader(nalu);
    if (header.type === AP_TYPE || header.type === FU_TYPE || header.type === PACI_TYPE) {
      throw new TypeError(`Annex-B input contains reserved RTP payload NAL type ${header.type}`);
    }

    if (nalu.length > maxPayload) {
      flushAggregation();
      payloads.push(...fragment(nalu, header, maxPayload));
      continue;
    }

    const candidate = [...aggregation, nalu];
    if (canAggregate(candidate, maxPayload)) {
      aggregation = candidate;
    } else {
      flushAggregation();
      aggregation = [nalu];
    }
  }
  flushAggregation();

  if (payloads.length > 0) payloads[payloads.length - 1]!.last = true;
  return payloads;
}

function parseNalHeader(nalu: Uint8Array): H265NalHeader {
  if (nalu.length <= NAL_HEADER_BYTES) {
    throw new TypeError("HEVC NAL unit must contain a two-byte header and payload");
  }
  const temporalIdPlusOne = nalu[1]! & 0x07;
  if (temporalIdPlusOne === 0) {
    throw new TypeError("HEVC NAL unit temporal_id_plus1 must not be zero");
  }
  return {
    forbidden: nalu[0]! >>> 7,
    type: (nalu[0]! >>> 1) & 0x3f,
    layerId: ((nalu[0]! & 0x01) << 5) | (nalu[1]! >>> 3),
    temporalIdPlusOne,
  };
}

function canAggregate(units: Uint8Array[], maxPayload: number): boolean {
  if (units.length < 2) return true;
  if (units.some((unit) => unit.length > 0xffff)) return false;
  const bytes = NAL_HEADER_BYTES + units.reduce((total, unit) => total + 2 + unit.length, 0);
  return bytes <= maxPayload;
}

function aggregate(units: Uint8Array[]): Uint8Array {
  const headers = units.map(parseNalHeader);
  const forbidden = headers.some((header) => header.forbidden !== 0) ? 1 : 0;
  const layerId = Math.min(...headers.map((header) => header.layerId));
  const temporalIdPlusOne = Math.min(...headers.map((header) => header.temporalIdPlusOne));
  const packedHeader = (forbidden << 15) | (AP_TYPE << 9) | (layerId << 3) | temporalIdPlusOne;
  const size = NAL_HEADER_BYTES + units.reduce((total, unit) => total + 2 + unit.length, 0);
  const payload = new Uint8Array(size);
  payload[0] = packedHeader >>> 8;
  payload[1] = packedHeader & 0xff;
  let offset = NAL_HEADER_BYTES;
  for (const unit of units) {
    payload[offset] = unit.length >>> 8;
    payload[offset + 1] = unit.length & 0xff;
    payload.set(unit, offset + 2);
    offset += 2 + unit.length;
  }
  return payload;
}

function fragment(nalu: Uint8Array, header: H265NalHeader, maxPayload: number): H265Payload[] {
  const payloads: H265Payload[] = [];
  const room = maxPayload - FU_HEADER_BYTES;
  const fuHeader0 = (nalu[0]! & 0x81) | (FU_TYPE << 1);
  const fuHeader1 = nalu[1]!;
  let offset = NAL_HEADER_BYTES;
  while (offset < nalu.length) {
    const end = Math.min(offset + room, nalu.length);
    const first = offset === NAL_HEADER_BYTES;
    const final = end === nalu.length;
    const payload = new Uint8Array(FU_HEADER_BYTES + end - offset);
    payload[0] = fuHeader0;
    payload[1] = fuHeader1;
    payload[2] = (first ? 0x80 : 0) | (final ? 0x40 : 0) | header.type;
    payload.set(nalu.subarray(offset, end), FU_HEADER_BYTES);
    payloads.push({ payload, last: false });
    offset = end;
  }
  return payloads;
}
