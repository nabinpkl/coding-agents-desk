// The one module that talks to a push service, and the only importer of `web-push`.
//
// `web-push` is pinned and accepted as an exception (`docs/dependency-exceptions.md`): it implements
// RFC 8030/8291/8292, which have not moved. Keeping it behind this file means a hand-rolled WebCrypto
// sender could replace it without touching a caller.

import webpush, { WebPushError } from "web-push";

export type VapidKeys = { publicKey: string; privateKey: string };

export type PushSubscriptionKeys = { endpoint: string; keys: { p256dh: string; auth: string } };

/** What the service worker shows. `url` is where a tap opens the panel. */
export type PushPayload = { title: string; body: string; url: string; tag?: string };

/** A push service's answer. `gone` means the subscription is dead and should be forgotten. */
export type PushOutcome = { endpoint: string; status: number; gone: boolean };

/** How long a push service holds a message for a device that is offline. */
const TIME_TO_LIVE_SECONDS = 60 * 60;

/**
 * How long one POST to a push service may take. `web-push` sets no timeout of its own, so without
 * this a connection that stalls holds the request, and whoever is waiting on it, for good.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

/**
 * Encrypts `payload` for one subscription and posts it to its push service.
 *
 * A push service's refusal is an outcome, not an exception: 404 and 410 say the subscription is
 * gone (the app was deleted, or permission withdrawn), and the caller forgets it. Anything that is
 * not an answer from the service -- DNS, TLS, a dropped connection -- throws.
 */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  payload: PushPayload,
  vapid: VapidKeys,
  subject: string,
): Promise<PushOutcome> {
  try {
    const result = await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: TIME_TO_LIVE_SECONDS,
      urgency: "high",
      timeout: REQUEST_TIMEOUT_MS,
      vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    return { endpoint: subscription.endpoint, status: result.statusCode, gone: false };
  } catch (error) {
    if (!(error instanceof WebPushError)) throw error;
    const gone = error.statusCode === 404 || error.statusCode === 410;
    if (!gone)
      console.warn(`[push] ${new URL(subscription.endpoint).host} answered ${error.statusCode}: ${error.body}`);
    return { endpoint: subscription.endpoint, status: error.statusCode, gone };
  }
}
