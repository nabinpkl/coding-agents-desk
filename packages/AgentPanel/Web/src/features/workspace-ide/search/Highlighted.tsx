// Text with its matched characters marked, for both searches' result rows.

/** `ranges` are `[start, end)` character offsets, sorted; overlapping ones are merged here. */
export function Highlighted({ text, ranges }: { text: string; ranges: ReadonlyArray<readonly [number, number]> }) {
  const parts: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const [from, to] of ranges) {
    const start = Math.max(from, at);
    if (to <= start) continue;
    if (start > at) parts.push({ text: text.slice(at, start), marked: false });
    parts.push({ text: text.slice(start, to), marked: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  return (
    <>
      {parts.map((part, index) =>
        part.marked ? (
          <mark key={index} className="rounded-[2px] bg-amber-300/50 text-inherit dark:bg-amber-400/30">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Fuzzy positions, one index per character, as the ranges `Highlighted` takes. */
export function positionRanges(positions: readonly number[], offset = 0): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const position of positions) {
    const at = position - offset;
    if (at < 0) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
}
