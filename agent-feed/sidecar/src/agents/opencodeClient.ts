// The one client for this machine's opencode serve, and the only place its
// password lives.
//
// `createOpencode()` (spawn-own-server) is deliberately never constructed: the
// user already runs one serve per machine, and a second one would split
// sessions across two servers with two ports. This holder connects to the
// running serve only, with the Basic password injected as a header so no
// caller ever handles auth. The panel never sees either value -- it talks to
// the sidecar's relay, which is the same boundary the Pi backends keep.

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "@/config/config";

let cached: OpencodeClient | null = null;

/** Null when no password is configured, which leaves the source unregistered. */
export function opencodeClient(): OpencodeClient | null {
  if (cached) return cached;
  if (!config.opencodePassword) return null;
  cached = createOpencodeClient({
    baseUrl: config.opencodeServeUrl.toString().replace(/\/$/, ""),
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${config.opencodePassword}`).toString("base64")}`,
    },
  });
  return cached;
}

/** Forgets the client so the next call rebuilds it, e.g. after a 401. */
export function resetOpencodeClient(): void {
  cached = null;
}

/**
 * One raw call to the serve, for the endpoints where the pinned SDK and the
 * running serve disagree on the body shape.
 *
 * Today that is exactly one: `POST /api/session/{id}/prompt` takes a flat
 * `{ text, delivery }` on serve v2.0.10 while the SDK sends a nested
 * `{ prompt: { text } }`. Measured, not assumed. Everything else travels the
 * SDK, and this stays until a bumped SDK matches the serve again.
 */
export async function serveRequest(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const password = config.opencodePassword;
  if (!password) throw new Error("opencode serve password is not configured");
  const url = new URL(path, config.opencodeServeUrl.toString().replace(/\/$/, ""));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: (await response.text()).slice(0, 500) };
}

/** True for the serve refusing the password rather than failing the call. */
export function isServeUnauthorized(error: unknown): boolean {
  return error instanceof Error && /401|unauthorized/i.test(error.message);
}

/**
 * One line out of a serve error body for logs and thrown errors.
 *
 * The SDK resolves HTTP failures as `{ error }` rather than throwing, so an
 * unchecked response reads as an empty success somewhere downstream. Every
 * call site checks `.error` and throws through here instead.
 */
export function describeServeError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error)?.slice(0, 300) ?? String(error);
  } catch {
    return String(error);
  }
}
