/* Message contract between the content script and the background
 * service worker. The background is the only code that talks to the server,
 * so the access token never enters page context. */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Why a call did not produce data. The panel shows a different state for each. */
export type FailureKind = "signed-out" | "offline" | "http";

export type Result<T> = { ok: true; data: T } | { ok: false; kind: FailureKind; status?: number; error: string };

export type AuthStatus = { serverUrl: string; signedIn: boolean };

export type BackgroundRequest =
  | { type: "api"; method: HttpMethod; path: string; body?: unknown }
  | { type: "screenshot-data-url"; id: number }
  | { type: "capture-visible-tab" }
  | { type: "badge"; count: number }
  | { type: "auth-status" }
  | { type: "sign-in" }
  | { type: "sign-out" };

/** Messages the background sends to a tab's content script. */
/** `dev-reload` is sent only by watch builds (src/dev/hot-reload-worker.ts). */
export type TabMessage = { type: "toggle" } | { type: "auth-changed" } | { type: "dev-reload" };

export function send<T>(req: BackgroundRequest): Promise<Result<T>> {
  return chrome.runtime.sendMessage(req).then(
    (res: Result<T> | undefined) => res ?? { ok: false, kind: "offline", error: "no response from background" },
    (e: unknown) => ({ ok: false, kind: "offline", error: String(e) }),
  );
}
