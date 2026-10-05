// A session's pane was just started: the moment a stopped session is running again.
//
// Announced rather than injected, the way the catalog announces its changes, because the one
// place that knows it -- `connectTmuxTerminal`, at the instant it creates a pane -- sits under a
// service whose collaborators are injected whole by its tests, and the one thing that acts on it
// (the Bot title queue) is wired at the server. A listener that throws is logged and the rest
// still hear it.

const listeners = new Set<(sessionId: string) => void>();

export function announceSessionPaneStarted(sessionId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId);
    } catch (error) {
      console.error("agent feed session pane start listener failed", error);
    }
  }
}

export function subscribeSessionPaneStarts(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
