// Publishes this machine's Bots to the hub, so `bot:<id>` addresses resolve and every surface can
// list them. The registry stays the authoritative home; the hub's copy is replaced whole on every
// publish, on each registry change and once a minute so a hub restart is healed without an event.

import type { BotSnapshot, PublishedBot } from "@agentdesk/agent-feed-wire";
import type { HubClient } from "@/messaging/hubClient";

const REPUBLISH_MS = 60_000;

export function publishedBots(snapshot: BotSnapshot): PublishedBot[] {
  return snapshot.bots.map((bot) => ({
    botId: bot.botId,
    name: bot.name,
    path: bot.environment.path,
    sessionIds: bot.sessionRefs.filter((ref) => ref.source === "claude").map((ref) => ref.sessionId),
  }));
}

export interface BotSource {
  snapshot(): Promise<BotSnapshot>;
  subscribe(listener: (snapshot: BotSnapshot) => void, onError?: (error: unknown) => void): Promise<() => void>;
}

/** Starts publishing; answers a stop function. Failures are logged and retried on the next tick. */
export async function startHubBotPublisher(
  bots: BotSource,
  hub: HubClient,
  log: (text: string) => void = (text) => console.error(`[hub-bots] ${text}`),
): Promise<() => void> {
  let lastError: string | null = null;
  const publish = async (snapshot: BotSnapshot) => {
    try {
      await hub.request("PUT", `/v1/directory/bots/${hub.settings.machine}`, { bots: publishedBots(snapshot) });
      if (lastError !== null) log("publishing again");
      lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Said once per distinct failure, not once a minute.
      if (message !== lastError) log(`publish failed: ${message}`);
      lastError = message;
    }
  };
  const unsubscribe = await bots.subscribe((snapshot) => void publish(snapshot), (error) => log(`registry: ${String(error)}`));
  const timer = setInterval(() => void bots.snapshot().then(publish), REPUBLISH_MS);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
