export type WordDiffKind = "same" | "machine-only" | "intended-only";

export interface WordDiffPart {
  readonly kind: WordDiffKind;
  readonly text: string;
}

function words(value: string): string[] {
  return value.trim().match(/\S+/gu) ?? [];
}

/**
 * Word-level LCS diff. It deliberately reports recognition differences without
 * assigning correctness to either side.
 */
export function wordDiff(
  machineTranscript: string,
  intendedText: string,
): readonly WordDiffPart[] {
  const machine = words(machineTranscript);
  const intended = words(intendedText);
  const table = Array.from(
    { length: machine.length + 1 },
    () => Array<number>(intended.length + 1).fill(0),
  );

  for (let left = machine.length - 1; left >= 0; left -= 1) {
    for (let right = intended.length - 1; right >= 0; right -= 1) {
      table[left][right] =
        machine[left] === intended[right]
          ? table[left + 1][right + 1] + 1
          : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const parts: WordDiffPart[] = [];
  let left = 0;
  let right = 0;
  while (left < machine.length || right < intended.length) {
    if (
      left < machine.length &&
      right < intended.length &&
      machine[left] === intended[right]
    ) {
      parts.push({ kind: "same", text: machine[left] });
      left += 1;
      right += 1;
    } else if (
      right >= intended.length ||
      (left < machine.length &&
        table[left + 1][right] >= table[left][right + 1])
    ) {
      parts.push({ kind: "machine-only", text: machine[left] });
      left += 1;
    } else {
      parts.push({ kind: "intended-only", text: intended[right] });
      right += 1;
    }
  }
  return parts;
}
