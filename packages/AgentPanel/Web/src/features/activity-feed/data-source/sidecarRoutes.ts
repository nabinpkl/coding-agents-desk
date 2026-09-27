// What every layer of the sidecar data source shares: the transport, and what an answer means.
//
// `SidecarDataSource` is one class with one API, split across files by what its methods are
// about. Each file is a layer extending the one below it, and this is the bottom: no routes of
// its own, just the transport they all call and the two ways a response is read.
//
// A chain rather than a facade over composed objects, because the alternative is fifty
// delegating methods that say nothing, each separated from the doc comment explaining it.

import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

/** Thrown when the sidecar answered, but with an error rather than the thing asked for. */
export class SidecarError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Parses a response body, or throws.
 *
 * A non-2xx carries a `{ error: { code, message } }` body the panel can act on -- an unsupported
 * mode reads differently from a session that is gone -- so the code is preserved rather than
 * flattened into a generic failure.
 */
export function parse<T>(response: { status: number; body: string }): T {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new SidecarError("malformed-response", "sidecar response was not JSON", response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    // A route the panel's code calls and this sidecar does not have is almost always a sidecar
    // running older code: held back by its supervisor, or a peer not shipped to yet. Saying so
    // points at the Profile menu, where the row says which machine and offers the restart.
    if (error?.code === "route-not-found") {
      throw new SidecarError(
        error.code,
        "This sidecar is running older code without this yet. Restart it from the Profile menu.",
        response.status,
      );
    }
    throw new SidecarError(
      error?.code ?? "sidecar-error",
      error?.message ?? `sidecar answered ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

export function expectEmpty(response: { status: number; body: string }): void {
  if (response.status >= 200 && response.status < 300) return;
  parse<never>(response);
}

/**
 * Enough of a session to name it in a URL.
 *
 * Commands take this rather than a full `SessionReference` because a command is not read in a
 * mode: aborting a run or answering a prompt means the same thing whichever view of the
 * transcript is on screen, and requiring the mode would invite a caller to invent one.
 */
export interface SessionAddress {
  source: string;
  sessionId: string;
}

/** The transport every layer calls, held once at the bottom of the chain. */
export class SidecarRoutes {
  constructor(protected readonly transport: AgentHttpTransport) {}
}
