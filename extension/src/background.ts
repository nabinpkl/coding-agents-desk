/* MV3 service worker. Owns every call to the annotator server (with the OAuth
 * token attached), tab capture, the badge, and the toolbar toggle. */
import { accessToken, isSignedIn, Offline, serverOrigin, setServerOrigin, signIn, signOut } from "./auth.ts";
import type { AuthStatus, BackgroundRequest, HttpMethod, Result, TabMessage } from "./messages.ts";

type Outcome = { kind: "response"; res: Response } | { kind: "signed-out" } | { kind: "offline"; error: string };

/** Sends one authorized request; on 401 refreshes once and retries. */
async function authorized(method: HttpMethod, path: string, body?: unknown): Promise<Outcome> {
  const origin = await serverOrigin();
  const attempt = async (token: string): Promise<Response> =>
    fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Access answers an unusable token with 401 or a redirect to its login page.
      redirect: "manual",
    });
  const rejected = (r: Response) => r.status === 401 || r.type === "opaqueredirect";
  try {
    let token = await accessToken();
    if (!token) return { kind: "signed-out" };
    let res = await attempt(token);
    if (rejected(res)) {
      token = await accessToken(true);
      if (!token) return { kind: "signed-out" };
      res = await attempt(token);
      if (rejected(res)) {
        await signOut();
        return { kind: "signed-out" };
      }
    }
    return { kind: "response", res };
  } catch (e) {
    if (e instanceof Offline || e instanceof TypeError) return { kind: "offline", error: String(e) };
    throw e;
  }
}

async function api(method: HttpMethod, path: string, body?: unknown): Promise<Result<unknown>> {
  const out = await authorized(method, path, body);
  if (out.kind === "signed-out") return { ok: false, kind: "signed-out", error: "sign in to the annotator server" };
  if (out.kind === "offline") return { ok: false, kind: "offline", error: out.error };
  const { res } = out;
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const data: unknown = text && isJson ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    return { ok: false, kind: "http", status: res.status, error: msg };
  }
  if (text && !isJson) return { ok: false, kind: "http", status: res.status, error: `unexpected ${res.headers.get("content-type")} response` };
  return { ok: true, data };
}

async function screenshotDataUrl(id: number): Promise<Result<string>> {
  const out = await authorized("GET", `/api/v1/annotations/${id}/screenshot`);
  if (out.kind === "signed-out") return { ok: false, kind: "signed-out", error: "sign in to the annotator server" };
  if (out.kind === "offline") return { ok: false, kind: "offline", error: out.error };
  if (!out.res.ok) return { ok: false, kind: "http", status: out.res.status, error: `HTTP ${out.res.status}` };
  const mime = out.res.headers.get("content-type") ?? "image/jpeg";
  const bytes = new Uint8Array(await out.res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { ok: true, data: `data:${mime};base64,${btoa(bin)}` };
}

async function authStatus(): Promise<AuthStatus> {
  const origin = await serverOrigin();
  return {
    serverUrl: origin,
    signedIn: await isSignedIn(),
    hasPermission: await chrome.permissions.contains({ origins: [`${origin}/*`] }),
  };
}

async function broadcast(msg: TabMessage): Promise<void> {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id != null) chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined);
  }
}

async function handle(req: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<Result<unknown>> {
  switch (req.type) {
    case "api":
      return api(req.method, req.path, req.body);
    case "screenshot-data-url":
      return screenshotDataUrl(req.id);
    case "capture-visible-tab": {
      const windowId = sender.tab?.windowId;
      if (windowId === undefined) return { ok: false, kind: "http", error: "capture needs a tab" };
      return { ok: true, data: await chrome.tabs.captureVisibleTab(windowId, { format: "png" }) };
    }
    case "badge":
      if (sender.tab?.id != null) {
        await chrome.action.setBadgeText({ tabId: sender.tab.id, text: req.count ? String(req.count) : "" });
        await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#c62828" });
      }
      return { ok: true, data: null };
    case "auth-status":
      return { ok: true, data: await authStatus() };
    case "sign-in":
      await signIn();
      await broadcast({ type: "auth-changed" });
      return { ok: true, data: await authStatus() };
    case "sign-out":
      await signOut();
      await broadcast({ type: "auth-changed" });
      return { ok: true, data: await authStatus() };
    case "set-server-url":
      await setServerOrigin(req.url);
      await broadcast({ type: "auth-changed" });
      return { ok: true, data: await authStatus() };
  }
}

chrome.runtime.onMessage.addListener((req: BackgroundRequest, sender, sendResponse) => {
  handle(req, sender).then(sendResponse, (e: unknown) => {
    console.error("[agentdesk-annotator]", req.type, e);
    sendResponse({ ok: false, kind: e instanceof Offline ? "offline" : "http", error: e instanceof Error ? e.message : String(e) });
  });
  return true;
});

async function toggleActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  // Pages without the content script (chrome://, the Web Store) cannot be annotated.
  await chrome.tabs.sendMessage(tab.id, { type: "toggle" } satisfies TabMessage).catch(() => undefined);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-annotate") void toggleActiveTab();
});
