// Web push between the panel and the sidecar (`agent-feed/sidecar/src/push/`).
//
// The panel fetches this machine's VAPID public key, subscribes its browser with it, and posts the
// browser's `PushSubscription.toJSON()` back. The push itself goes from the sidecar to the browser's
// push service (Apple or Google), never through this wire.

export const PUSH_KEY_ROUTE = "/api/push/key";
export const PUSH_SUBSCRIPTIONS_ROUTE = "/api/push/subscriptions";
export const PUSH_TEST_ROUTE = "/api/push/test";

/** `GET /api/push/key`: the VAPID public key, base64url, as `applicationServerKey` takes it. */
export type PushKeyResponse = { publicKey: string };

/** `POST /api/push/test`: what each subscribed device's push service answered. */
export type PushTestResponse = { sent: { host: string; status: number; gone: boolean }[] };
