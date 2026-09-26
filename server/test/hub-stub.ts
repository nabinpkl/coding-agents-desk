/* A HubClient that answers from memory, for the service tests that never touch
 * the hub. The integration path in send.test.ts uses the real client against a
 * fake edge instead, so this stays a stub and not a second implementation. */
import type { Recipient, SendState } from "../../shared/send.ts";
import type { HubClient } from "../src/hub.ts";

export interface StubSend {
  to: string;
  body: string;
  refs: Array<{ app: string; kind: string; id: string; url?: string }>;
}

export interface StubHub extends HubClient {
  readonly sent: StubSend[];
  /** How many times the service asked who to send to. */
  readonly directoryCalls: number;
  /** Makes every call throw, for the tests that want the hub to be down. */
  failWith(error: Error): void;
  /** The state a message will report, so a test can watch the state move. */
  setState(messageId: string, state: SendState): void;
}

export function createStubHub(directory: Recipient[] = []): StubHub {
  const sent: StubSend[] = [];
  const states = new Map<string, SendState>();
  let directoryCalls = 0;
  let failure: Error | null = null;
  let counter = 0;
  return {
    sent,
    get directoryCalls() {
      return directoryCalls;
    },
    failWith(error) {
      failure = error;
    },
    setState(messageId, state) {
      states.set(messageId, state);
    },
    async directory() {
      if (failure) throw failure;
      directoryCalls += 1;
      return directory;
    },
    async send({ to, body, refs }) {
      if (failure) throw failure;
      const id = `msg-${++counter}`;
      states.set(id, "queued");
      sent.push({ to, body, refs });
      return { id, to, state: "queued" };
    },
    async message(id) {
      if (failure) throw failure;
      return { state: states.get(id) ?? "queued" };
    },
  };
}

/** A reachable session, with the fields a test rarely cares about spelled once. */
export function session(over: Partial<Recipient> & { address: string; name: string }): Recipient {
  return { machine: "mac", cwd: "/work", reachability: "reachable", lastSeenAt: null, related: [], ...over };
}
