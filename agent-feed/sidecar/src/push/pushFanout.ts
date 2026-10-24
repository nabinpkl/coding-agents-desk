// One payload to every subscribed device: the test route's send and every notification the sidecar
// raises on its own go through here, so both settle and clean up the same way.

import type { PushOutcome, PushPayload, PushSubscriptionKeys, VapidKeys } from "@/push/pushSender";
import { readPushState, removeSubscriptions } from "@/push/pushStore";

export type PushSend = (
  subscription: PushSubscriptionKeys,
  payload: PushPayload,
  vapid: VapidKeys,
  subject: string,
) => Promise<PushOutcome>;

/**
 * Sends `payload` to every stored subscription and forgets the ones a push service called gone.
 * An empty answer means no device has allowed notifications.
 *
 * Settled rather than all: one device whose push service cannot be reached must not cost the others
 * their send, or the cleanup of the ones a service called gone. Each is one request with no retry; a
 * failure is reported as status 0, and the next notification tries again.
 */
export async function pushToAll(
  path: string,
  payload: PushPayload,
  subject: string,
  send: PushSend,
): Promise<PushOutcome[]> {
  const state = await readPushState(path);
  if (!state || state.subscriptions.length === 0) return [];
  const settled = await Promise.allSettled(
    state.subscriptions.map((subscription) => send(subscription, payload, state.vapid, subject)),
  );
  const outcomes = settled.map((result, index): PushOutcome => {
    if (result.status === "fulfilled") return result.value;
    const endpoint = state.subscriptions[index]?.endpoint ?? "";
    console.warn(`[push] sending to ${new URL(endpoint).host} failed`, result.reason);
    return { endpoint, status: 0, gone: false };
  });
  await removeSubscriptions(
    path,
    outcomes.filter((outcome) => outcome.gone).map((outcome) => outcome.endpoint),
  );
  return outcomes;
}
