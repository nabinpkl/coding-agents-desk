// A transcript under one of the watched corpora was written, and who wants to know.
//
// The catalog already watches every corpus with ONE recursive `fs.watch` per root, for the
// reasons `watchTree.ts` sets out. This is the seam that lets the event index read that same
// signal instead of opening a watch of its own: a transcript that grew has rows to hand to
// whoever is following it.
//
// Why the index stopped watching for itself, measured 2026-09-15 against the running sidecar
// with a throwaway session and 20 sent messages. Its per-file watches were delivering a
// transcript's growth 30 to 200 seconds late and in bursts, so a message a reader had just
// sent did not appear until the turn after it. In the SAME process, at the same instants, the
// catalog's recursive watch reported those writes within 3 seconds every time, to the same
// millisecond a freshly started sidecar reported them. A fresh sidecar delivered in about a
// second either way, with `bun --watch` or without, so the fault was neither the OS, nor
// chokidar, nor Bun's `fs.watch`: it was hundreds of per-file watches in one long-lived
// process. One recursive watch per corpus stays healthy where those do not.
//
// Deliberately not typed to a source or a session. A publisher knows a path changed and
// nothing else, and the index is the half that knows whether anyone is reading it.

const listeners = new Set<(path: string) => void>();

/**
 * Says that `path` was written, to every listener.
 *
 * Called from the corpus watchers in `transcriptCatalog.ts`. A listener that throws is
 * reported and the rest still hear: one broken follower must not silence the others.
 */
export function publishTranscriptWrite(path: string): void {
  for (const listener of listeners) {
    try {
      listener(path);
    } catch (error) {
      console.error("agent feed transcript write listener failed", error);
    }
  }
}

/** Hears about every transcript write under a watched corpus. Returns the unsubscribe. */
export function onTranscriptWrite(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
