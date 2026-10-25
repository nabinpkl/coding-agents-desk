// The web push state this machine keeps: the VAPID key pair every push is signed with, and the
// subscriptions (one per installed panel that allowed notifications) it sends to.
//
// One file for both, because a subscription is bound to the public key it was made with: a new key
// pair silently orphans every subscription, so they live and die together. The stable and dev
// sidecars share the file like `bots.json`, so every write takes its lock.

import { readFile } from "node:fs/promises";
import { acquireFileLock, writeJsonAtomically } from "@/config/lockedJsonFile";
import { generateVapidKeys, type PushSubscriptionKeys, type VapidKeys } from "@/push/pushSender";

export type PushSubscriptionRecord = PushSubscriptionKeys & { addedAt: string };

type PushState = { vapid: VapidKeys; subscriptions: PushSubscriptionRecord[] };

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The subscription shape a browser's `PushSubscription.toJSON()` gives, or null. */
export function parseSubscription(value: unknown): PushSubscriptionKeys | null {
  if (value === null || typeof value !== "object") return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (!isString(endpoint) || keys === null || typeof keys !== "object") return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (!isString(p256dh) || !isString(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function parseState(text: string, path: string): PushState {
  const value: unknown = JSON.parse(text);
  const { vapid, subscriptions } = (value ?? {}) as { vapid?: unknown; subscriptions?: unknown };
  const keys = (vapid ?? {}) as { publicKey?: unknown; privateKey?: unknown };
  if (!isString(keys.publicKey) || !isString(keys.privateKey) || !Array.isArray(subscriptions)) {
    throw new Error(`web push state at ${path} is not { vapid, subscriptions }`);
  }
  const records = subscriptions.map((entry: unknown) => {
    const parsed = parseSubscription(entry);
    const addedAt = (entry as { addedAt?: unknown } | null)?.addedAt;
    if (!parsed || !isString(addedAt)) throw new Error(`web push state at ${path} holds a malformed subscription`);
    return { ...parsed, addedAt };
  });
  return { vapid: { publicKey: keys.publicKey, privateKey: keys.privateKey }, subscriptions: records };
}

/** The stored state, or null when no key pair has been made yet. */
export async function readPushState(path: string): Promise<PushState | null> {
  try {
    return parseState(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function updatePushState(path: string, change: (state: PushState | null) => PushState): Promise<PushState> {
  const release = await acquireFileLock(path);
  try {
    const next = change(await readPushState(path));
    await writeJsonAtomically(path, next);
    return next;
  } finally {
    await release();
  }
}

/** The key pair, made and stored the first time anything asks for it. */
export async function ensureVapidKeys(path: string): Promise<VapidKeys> {
  const existing = await readPushState(path);
  if (existing) return existing.vapid;
  const state = await updatePushState(path, (current) => current ?? { vapid: generateVapidKeys(), subscriptions: [] });
  return state.vapid;
}

/**
 * Adds a subscription, replacing any earlier one for the same endpoint. The panel posts its
 * subscription again on every load, so a known endpoint keeps the `addedAt` it was first stored with.
 */
export async function addSubscription(path: string, subscription: PushSubscriptionKeys, now: Date): Promise<void> {
  await updatePushState(path, (state) => {
    if (!state) throw new Error("a subscription arrived before any VAPID key was handed out");
    const earlier = state.subscriptions.find((entry) => entry.endpoint === subscription.endpoint);
    const others = state.subscriptions.filter((entry) => entry !== earlier);
    const addedAt = earlier?.addedAt ?? now.toISOString();
    return { ...state, subscriptions: [...others, { ...subscription, addedAt }] };
  });
}

/** Forgets the subscriptions a push service said are gone. */
export async function removeSubscriptions(path: string, endpoints: readonly string[]): Promise<void> {
  if (endpoints.length === 0) return;
  await updatePushState(path, (state) => {
    if (!state) throw new Error("removing subscriptions from a web push state that does not exist");
    return { ...state, subscriptions: state.subscriptions.filter((entry) => !endpoints.includes(entry.endpoint)) };
  });
}
