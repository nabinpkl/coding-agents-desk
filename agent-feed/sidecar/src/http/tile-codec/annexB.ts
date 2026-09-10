/** Split a codec Annex-B access unit into bare NAL units. */
export function splitAnnexB(accessUnit: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let delimiter = findStartCode(accessUnit, 0);
  while (delimiter) {
    const next = findStartCode(accessUnit, delimiter.payloadStart);
    const payloadEnd = next?.start ?? accessUnit.length;
    if (payloadEnd > delimiter.payloadStart) {
      units.push(accessUnit.subarray(delimiter.payloadStart, payloadEnd));
    }
    delimiter = next;
  }
  return units;
}

interface AnnexBStartCode {
  start: number;
  payloadStart: number;
}

function findStartCode(data: Uint8Array, from: number): AnnexBStartCode | undefined {
  for (let index = from; index + 2 < data.length; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    if (index + 3 < data.length && data[index + 2] === 0 && data[index + 3] === 1) {
      return { start: index, payloadStart: index + 4 };
    }
    if (data[index + 2] === 1) {
      return { start: index, payloadStart: index + 3 };
    }
  }
  return undefined;
}
