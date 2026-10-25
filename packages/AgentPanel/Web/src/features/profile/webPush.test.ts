import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH_KEY_ROUTE, PUSH_SUBSCRIPTIONS_ROUTE } from "@agentdesk/agent-feed-wire";
import { renewPushSubscription } from "@/features/profile/webPush";

// The sidecar's key, base64url, and the same four bytes as a subscription stores them.
const CURRENT_KEY = "AQIDBA";
const CURRENT_BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
const OLD_BYTES = new Uint8Array([9, 9, 9, 9]).buffer;

function fakeSubscription(endpoint: string, key: ArrayBuffer) {
  return {
    options: { applicationServerKey: key },
    unsubscribe: vi.fn(() => Promise.resolve(true)),
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

function install({
  permission = "granted",
  existing,
  registered = true,
}: {
  permission?: NotificationPermission;
  existing?: ReturnType<typeof fakeSubscription> | null;
  registered?: boolean;
}) {
  const fresh = fakeSubscription("https://web.push.apple.com/fresh", CURRENT_BYTES);
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(existing ?? null)),
    subscribe: vi.fn(() => Promise.resolve(fresh)),
  };
  const posted: unknown[] = [];
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: vi.fn(() => Promise.resolve(registered ? { pushManager } : undefined)) },
  });
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input === PUSH_KEY_ROUTE) return Promise.resolve(Response.json({ publicKey: CURRENT_KEY }));
    if (input === PUSH_SUBSCRIPTIONS_ROUTE) {
      posted.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unexpected fetch ${input}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { pushManager, posted, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.restoreAllMocks();
});

describe("renewPushSubscription", () => {
  it("posts the subscription it already has when the key has not changed", async () => {
    const existing = fakeSubscription("https://web.push.apple.com/kept", CURRENT_BYTES);
    const { pushManager, posted } = install({ existing });
    await renewPushSubscription();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(posted).toEqual([{ endpoint: "https://web.push.apple.com/kept", keys: { p256dh: "p", auth: "a" } }]);
  });

  it("replaces a subscription made with an older key and posts the new one", async () => {
    const existing = fakeSubscription("https://web.push.apple.com/old", OLD_BYTES);
    const { pushManager, posted } = install({ existing });
    await renewPushSubscription();
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    expect(posted).toEqual([{ endpoint: "https://web.push.apple.com/fresh", keys: { p256dh: "p", auth: "a" } }]);
  });

  it("subscribes again when the push service dropped the subscription", async () => {
    const { pushManager, posted } = install({ existing: null });
    await renewPushSubscription();
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    expect(posted).toHaveLength(1);
  });

  it("leaves a browser alone that never turned notifications on", async () => {
    const denied = install({ permission: "default" });
    await renewPushSubscription();
    expect(denied.fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const unregistered = install({ registered: false });
    await renewPushSubscription();
    expect(unregistered.fetchMock).not.toHaveBeenCalled();
  });

  it("logs a failure instead of throwing, since nothing on the page waits for it", async () => {
    const { pushManager } = install({ existing: null });
    pushManager.subscribe.mockImplementation(() => Promise.reject(new Error("no gesture")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(renewPushSubscription()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("renewing"), expect.any(Error));
  });
});
