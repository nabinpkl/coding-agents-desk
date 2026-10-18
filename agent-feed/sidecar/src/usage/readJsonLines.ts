// Streams a JSONL file line by line, without holding the file in memory.
//
// Not an optimization. The largest rollout in one real Codex history is 338 MB, and a scan runs
// several files at once, so `Bun.file(path).text()` would allocate gigabytes to look at the 0.1%
// of lines that carry usage. The transcript reads do their own chunked reads for their own
// reasons (lines by byte position, in either direction); this needs neither, so it takes the plainer
// stream rather than borrowing machinery built for a different question.

const decoder = new TextDecoder();

/**
 * Calls `onLine` for each nonempty line. Lines arrive in file order.
 *
 * The callback is synchronous by design: it is invoked once per line of a multi-gigabyte corpus,
 * and an async boundary there costs a promise per line for work that is a string test and an
 * occasional `JSON.parse`.
 */
export async function readJsonLines(path: string, onLine: (line: string) => void): Promise<void> {
  const stream = Bun.file(path).stream();
  let carry = "";
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    let newline = carry.indexOf("\n");
    while (newline >= 0) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  // A file still being appended to ends mid-line as often as not. The tail is handed over only
  // when it parses; a half-written record is skipped by the caller's own `JSON.parse` guard.
  if (carry.length > 0) onLine(carry);
}
