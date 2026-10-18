// The one client for this machine's opencode serve, and the only place its
// password lives.
//
// `createOpencode()` (spawn-own-server) is deliberately never constructed: the
// user already runs one serve per machine, and a second one would split
// sessions across two servers with two ports. This holder connects to the
// running serve only, with the Basic password injected as a header so no
// caller ever handles auth. The panel never sees either value -- it talks to
// the sidecar's relay, which is the same boundary the Pi backends keep.

import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { config } from "@/config/config";

/**
 * The serve's own client release, pinned to the serve's version (2.0.16): every call resolves
 * to its body and throws a `ClientError` on a failed status, rather than resolving `{ error }`.
 */
export type OpencodeClient = OpenCodeClient;

let cached: OpencodeClient | null = null;

/** Null when no password is configured, which leaves the source unregistered. */
export function opencodeClient(): OpencodeClient | null {
  if (cached) return cached;
  if (!config.opencodePassword) return null;
  cached = OpenCode.make({
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
 * Raw calls to the serve, for the endpoints the sidecar has always reached by path.
 *
 * They began as the endpoints where the old `@opencode-ai/sdk` and the running serve
 * disagreed -- the prompt's flat `{ text, delivery }`, message paging by `order` and `cursor`,
 * and the command's flat `{ name, text }` -- and the client now matches the serve. They stay
 * raw because each call site parses exactly the fields it reads, and moving them is a change
 * of its own rather than part of swapping the client.
 */
export async function serveRequest(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const { response } = await serveCall("POST", path, body);
  return { status: response.status, text: (await response.text()).slice(0, 500) };
}

/**
 * A raw GET that keeps the whole body: history pages carry full tool
 * outputs and run to megabytes, so unlike `serveRequest` nothing is sliced.
 */
export async function serveGet(path: string): Promise<{ status: number; text: string }> {
  const { response } = await serveCall("GET", path);
  return { status: response.status, text: await response.text() };
}

/**
 * Raw non-GET calls beyond `serveRequest`: the local session ops (compact, revert, rename)
 * each need the status plus the whole small body, and PATCH has no other caller.
 */
export async function serveWrite(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const { response } = await serveCall(method, path, body);
  return { status: response.status, text: await response.text() };
}

async function serveCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ response: Response }> {
  const password = config.opencodePassword;
  if (!password) throw new Error("opencode serve password is not configured");
  const url = new URL(path, config.opencodeServeUrl.toString().replace(/\/$/, ""));
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response };
}

/**
 * True for the serve refusing the password rather than failing the call. The client carries
 * a failed status on its error's `cause`; the message test covers errors raised elsewhere.
 */
export function isServeUnauthorized(error: unknown): boolean {
  const status = (error as { cause?: { status?: unknown } } | null)?.cause?.status;
  if (status === 401) return true;
  return error instanceof Error && /401|unauthorized/i.test(error.message);
}
