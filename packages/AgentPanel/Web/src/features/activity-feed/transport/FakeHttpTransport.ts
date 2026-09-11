/**
 * A transport that answers from a script instead of a sidecar. Test-only.
 *
 * It stands in one layer below the data source, which is the seam worth faking: everything above
 * it is the code under test, and everything below it is HTTP, whose behaviour is not this repo's
 * to assert.
 */

import type {
  AgentHttpTransport,
  SubscribeHandlers,
  TransportResponse,
} from "@/features/activity-feed/transport/AgentHttpTransport";

interface OpenSubscription {
  path: string;
  handlers: SubscribeHandlers;
}

export class FakeHttpTransport implements AgentHttpTransport {
  /** Every request made, in order, so a test can assert the path and body it produced. */
  readonly requests: Array<{ method: string; path: string; body?: unknown }> = [];

  /** Every subscription opened and not yet cancelled. */
  readonly subscriptions: OpenSubscription[] = [];

  /** Canned answers by `"METHOD /path"`, consulted before `defaultResponse`. */
  readonly responses = new Map<string, TransportResponse>();

  defaultResponse: TransportResponse = { status: 200, body: "{}" };

  /** Requests held open by `hold`, by `"METHOD /path"`. */
  private readonly held = new Map<string, Promise<void>>();

  /**
   * Hold every future request to `key` open until the returned function is called.
   *
   * For asserting what the code under test does *while* a request is outstanding, which is where
   * in-flight guards and races live. The request is still recorded when it is made, so a test can
   * count requests before releasing.
   */
  hold(key: string): () => void {
    let release!: () => void;
    this.held.set(key, new Promise<void>((resolve) => {
      release = resolve;
    }));
    return () => {
      this.held.delete(key);
      release();
    };
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {},
  ): Promise<TransportResponse> {
    const key = `${method} ${path}`;
    this.requests.push({ method, path, body: options.body });
    const gate = this.held.get(key);
    if (gate) await gate;
    return this.responses.get(key) ?? this.defaultResponse;
  }

  subscribe(path: string, handlers: SubscribeHandlers): () => void {
    const subscription = { path, handlers };
    this.subscriptions.push(subscription);
    return () => {
      const at = this.subscriptions.indexOf(subscription);
      if (at >= 0) this.subscriptions.splice(at, 1);
    };
  }

  /** Delivers one message to the newest subscription whose path contains `match`. */
  deliver(match: string, payload: unknown): void {
    const subscription = this.find(match);
    subscription.handlers.onMessage(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  }

  /** Opens the newest subscription whose path contains `match`. */
  open(match: string, status = 200): void {
    this.find(match).handlers.onOpen?.(status);
  }

  /** Fails the newest subscription whose path contains `match`. */
  fail(match: string, reason = "stream failed"): void {
    this.find(match).handlers.onError(reason);
  }

  private find(match: string): OpenSubscription {
    const subscription = [...this.subscriptions]
      .reverse()
      .find((open: OpenSubscription) => open.path.includes(match));
    if (!subscription) {
      throw new Error(
        `no open subscription matching "${match}" (open: ${this.subscriptions.map((s) => s.path).join(", ") || "none"})`,
      );
    }
    return subscription;
  }
}
