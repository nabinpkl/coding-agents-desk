// Web push from the panel's side: register the push-only service worker (`public/sw.js`), ask for
// permission, subscribe this browser with the machine's VAPID key, and hand the subscription to the
// sidecar (`agent-feed/sidecar/src/push/`), which is what sends.
//
// On an iPhone this works only in the panel installed to the Home Screen, never in a browser tab:
// that is Apple's rule, and `pushReadiness` reports "unsupported" there.

import {
  PUSH_KEY_ROUTE,
  PUSH_SUBSCRIPTIONS_ROUTE,
  PUSH_TEST_ROUTE,
  type PushKeyResponse,
  type PushTestResponse,
} from "@agentdesk/agent-feed-wire";

export type PushReadiness = "unsupported" | NotificationPermission;

export function pushReadiness(): PushReadiness {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameBytes(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  const view = new Uint8Array(left);
  return view.every((byte, index) => byte === right[index]);
}

async function sidecarJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`sidecar answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Subscribes `registration` with the sidecar's current key and hands the subscription to the
 * sidecar. A subscription made with an older key pair would be refused by the push service, so it
 * is replaced rather than reused; one made with the current key is posted again as it is, which is
 * what restores it if the sidecar forgot it.
 */
async function syncSubscription(registration: ServiceWorkerRegistration): Promise<void> {
  const { publicKey } = await sidecarJson<PushKeyResponse>(await fetch(PUSH_KEY_ROUTE));
  const key = decodeBase64Url(publicKey);

  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  const response = await fetch(PUSH_SUBSCRIPTIONS_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error(`sidecar answered ${response.status}: ${await response.text()}`);
}

/**
 * Turns notifications on for this browser. Call it straight from a tap: the permission prompt is
 * asked for first, while the tap is still the current user gesture, because iOS shows it only then.
 */
export async function enableNotifications(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(`notifications are ${permission}`);
  const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  await navigator.serviceWorker.ready;
  await syncSubscription(registration);
}

/**
 * Once per page load (`app/main.tsx`): where notifications were already turned on, hands the
 * sidecar this browser's subscription again. That repairs, without anyone pressing Enable, the two
 * ways delivery stops silently: the push service dropped the subscription and the sidecar deleted
 * it on a 410, or the sidecar's key pair was made anew and every old subscription went dead.
 *
 * A browser that never pressed Enable has no registration and is left alone. A failure is logged
 * rather than thrown, because nothing on the page waits for this; pressing Enable again is the fix.
 */
export async function renewPushSubscription(): Promise<void> {
  if (pushReadiness() !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("./");
    if (registration) await syncSubscription(registration);
  } catch (error) {
    console.warn("[push] renewing this browser's subscription failed; press Enable notifications", error);
  }
}

/** Asks the sidecar to push a test notification to every subscribed device; says what each answered. */
export async function sendTestNotification(): Promise<string> {
  const { sent } = await sidecarJson<PushTestResponse>(await fetch(PUSH_TEST_ROUTE, { method: "POST" }));
  return sent.map((entry) => `${entry.host} ${entry.status}${entry.gone ? " (gone)" : ""}`).join(", ");
}
