/**
 * A fetch-shaped view of the agent-feed sidecar, wherever the panel happens to be running.
 *
 * The panel used to reach the sidecar through a typed message per operation: a request tag, a
 * response tag, and a Swift struct for each, restated on both sides of the wire with a renaming
 * layer in between. Adding one field edited four definitions and passed every per-side test.
 *
 * Here there is one shape -- request in, status and body out -- and the sidecar's own routes are
 * the API. A new endpoint is a sidecar change and a call site here; nothing in between knows it
 * happened.
 *
 * Two backends, because the panel runs in two places:
 *   - In the WKWebView, the host relays. It holds the sidecar's control token, which is the whole
 *     reason it is still in the path: that token is a capability the host mints per spawn, and a
 *     page rendering agent-authored markdown must never hold it.
 *   - In a browser during development, `fetch` goes to Vite, which proxies `/api` and injects the
 *     same header. Same paths, same responses, no relay.
 */

import type { HostBridge } from "../data-source/HostBridge";

/** One relayed response, as it arrives. */
export interface TransportResponse {
  status: number;
  body: string;
}

/** A subscription's callbacks. `onMessage` fires once per server-sent message. */
export interface SubscribeHandlers {
  onOpen?: (status: number) => void;
  onMessage: (payload: string) => void;
  onError: (reason: string) => void;
}

export interface AgentHttpTransport {
  /**
   * Performs one request and resolves with the complete response.
   *
   * A non-2xx status resolves rather than rejecting: the sidecar answers errors as JSON bodies
   * with codes the caller can act on, and turning them into exceptions would throw that away.
   * Rejection means the request never got an answer at all.
   */
  request(
    method: string,
    path: string,
    options?: { body?: unknown; signal?: AbortSignal },
  ): Promise<TransportResponse>;

  /** Follows a server-sent event stream. Returns unsubscribe. */
  subscribe(path: string, handlers: SubscribeHandlers): () => void;
}

// ---------------------------------------------------------------------------
// Relay envelope
// ---------------------------------------------------------------------------

/**
 * The six frames the host relay speaks. Mirrors `AgentFeedRelayFrames.swift`, and this is
 * deliberately the ONLY shape shared with Swift: it carries no field of anything the sidecar
 * says, so it is stable in a way the payloads never were.
 */
interface RelayHead {
  t: "agent-http-head";
  rid: string;
  status: number;
}
interface RelayChunk {
  t: "agent-http-chunk";
  rid: string;
  seq: number;
  data: string;
  complete: boolean;
}
interface RelayEnd {
  t: "agent-http-end";
  rid: string;
}
interface RelayError {
  t: "agent-http-err";
  rid: string;
  reason: string;
}

type RelayFrame = RelayHead | RelayChunk | RelayEnd | RelayError;

function relayFrame(message: unknown): RelayFrame | null {
  if (typeof message !== "object" || message === null) return null;
  const type = (message as { t?: unknown }).t;
  if (
    type !== "agent-http-head" &&
    type !== "agent-http-chunk" &&
    type !== "agent-http-end" &&
    type !== "agent-http-err"
  ) {
    return null;
  }
  return message as RelayFrame;
}

/** One in-flight request's reassembly state. */
interface Transfer {
  status: number | null;
  /** Chunks of the message being reassembled, cleared at each completion. */
  parts: string[];
  /** The next `seq` expected, so a dropped or reordered chunk fails loudly. */
  nextSeq: number;
  onComplete: (body: string) => void;
  onDone: () => void;
  onFail: (reason: string) => void;
  onStatus: (status: number) => void;
}

let nextRequestId = 0;

/**
 * The transport used inside the WKWebView: every request goes through the host relay.
 *
 * Owns request-id correlation and chunk reassembly, and nothing else. It does not know what any
 * path means or what any body contains, which is why it does not change when the feed does.
 */
export class RelayHttpTransport implements AgentHttpTransport {
  private readonly transfers = new Map<string, Transfer>();
  private readonly detach: () => void;

  constructor(private readonly channel: HostBridge) {
    this.detach = channel.onHostMessage((message) => this.receive(message));
  }

  /** Abandons every in-flight request. Each one fails so no caller waits forever. */
  dispose(): void {
    this.detach();
    for (const [rid, transfer] of this.transfers) {
      this.transfers.delete(rid);
      transfer.onFail("transport disposed");
    }
  }

  request(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      const rid = this.open(path, {
        method,
        body: options.body,
        stream: false,
        onStatus: () => {},
        onComplete: () => {},
        onFail: reject,
      });
      // A one-shot response completes at `end`, so the last chunk is what resolves it. Held
      // rather than resolved on arrival because `end` is what says the relay is finished with
      // this rid, and resolving early would race the cleanup.
      const transfer = this.transfers.get(rid)!;
      let body = "";
      transfer.onComplete = (chunk) => {
        body = chunk;
      };
      transfer.onDone = () => resolve({ status: transfer.status ?? 0, body });
      options.signal?.addEventListener("abort", () => {
        this.cancel(rid);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }

  subscribe(path: string, handlers: SubscribeHandlers): () => void {
    // A stream that opened with an error status is not a stream, and saying nothing about it is
    // the worst of the three options: the sidecar answers a bad request with a 4xx whose body is
    // a coded error, that body reaches `onMessage` looking like data, every subscriber ignores it
    // for not having the shape it wanted, and the panel waits forever on a request that was
    // ANSWERED. The `fetch` backend does not have this problem -- `EventSource` treats a non-2xx
    // open as an error -- so this is also what makes the two backends behave alike.
    let failedWith: number | null = null;
    const rid = this.open(path, {
      method: "GET",
      stream: true,
      onStatus: (status) => {
        if (status >= 200 && status < 300) {
          handlers.onOpen?.(status);
          return;
        }
        failedWith = status;
      },
      onComplete: (message) => {
        if (failedWith === null) {
          handlers.onMessage(message);
          return;
        }
        // The body is passed through rather than parsed: what the code means is the data
        // source's business, and this layer knowing would be the restatement this whole
        // transport exists to avoid.
        this.cancel(rid);
        handlers.onError(`sidecar answered ${failedWith}: ${message}`);
      },
      onFail: (reason) => handlers.onError(reason),
    });
    // An error response with an empty body ends without ever completing a message, so the end of
    // the transfer is the last chance to report it.
    this.transfers.get(rid)!.onDone = () => {
      if (failedWith !== null) handlers.onError(`sidecar answered ${failedWith}`);
    };
    return () => this.cancel(rid);
  }

  private open(
    path: string,
    options: {
      method: string;
      body?: unknown;
      stream: boolean;
      onStatus: (status: number) => void;
      onComplete: (body: string) => void;
      onFail: (reason: string) => void;
    },
  ): string {
    nextRequestId += 1;
    const rid = `r${nextRequestId}`;
    this.transfers.set(rid, {
      status: null,
      parts: [],
      nextSeq: 0,
      onStatus: options.onStatus,
      onComplete: options.onComplete,
      onDone: () => {},
      onFail: options.onFail,
    });
    this.channel.postToHost({
      t: "agent-http-req",
      rid,
      method: options.method,
      path,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      stream: options.stream,
    });
    return rid;
  }

  private cancel(rid: string): void {
    if (!this.transfers.delete(rid)) return;
    this.channel.postToHost({ t: "agent-http-cancel", rid });
  }

  private receive(message: unknown): void {
    const frame = relayFrame(message);
    if (!frame) {
      // Dropping an unknown frame is correct -- this channel also carries the host's
      // native-authority replies, which are not ours. But a frame that CARRIES a rid we are
      // waiting on and still does not parse is a relay we no longer understand, and staying
      // quiet about it is how a whole silenced direction looks exactly like an idle one.
      const rid = (message as { rid?: unknown } | null)?.rid;
      if (typeof rid === "string" && this.transfers.has(rid)) {
        console.error("[AgentHttpTransport] unrecognised relay frame for", rid, message);
      }
      return;
    }
    const transfer = this.transfers.get(frame.rid);
    // A frame for a rid we cancelled is expected, not an error: cancel and the relay's last
    // frames cross in flight. Frames for no rid at all are expected too: the same channel carries
    // the host's native-authority replies, which `HostActionsClient` reads.
    if (!transfer) return;

    switch (frame.t) {
      case "agent-http-head":
        transfer.status = frame.status;
        transfer.onStatus(frame.status);
        return;
      case "agent-http-chunk":
        if (frame.seq !== transfer.nextSeq) {
          // Reassembling out of order would silently produce a body that parses but is wrong,
          // so a gap ends the transfer instead.
          this.fail(frame.rid, `chunk ${frame.seq} arrived, expected ${transfer.nextSeq}`);
          return;
        }
        transfer.parts.push(frame.data);
        transfer.nextSeq += 1;
        if (frame.complete) {
          const body = transfer.parts.join("");
          transfer.parts.length = 0;
          transfer.onComplete(body);
        }
        return;
      case "agent-http-end":
        this.transfers.delete(frame.rid);
        transfer.onDone();
        return;
      case "agent-http-err":
        this.fail(frame.rid, frame.reason);
        return;
    }
  }

  private fail(rid: string, reason: string): void {
    const transfer = this.transfers.get(rid);
    if (!transfer) return;
    this.transfers.delete(rid);
    transfer.onFail(reason);
  }
}

/**
 * The transport used when the panel runs in a browser: talk to the sidecar directly.
 *
 * The dev server proxies `/api` and attaches the control token, so paths and responses are
 * identical to the relayed ones and every layer above this is unaware of which one it has.
 */
export class FetchHttpTransport implements AgentHttpTransport {
  constructor(private readonly origin = "") {}

  async request(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<TransportResponse> {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      signal: options.signal,
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.text() };
  }

  subscribe(path: string, handlers: SubscribeHandlers): () => void {
    const source = new EventSource(`${this.origin}${path}`);
    source.onopen = () => handlers.onOpen?.(200);
    source.onmessage = (event) => handlers.onMessage(event.data);
    source.onerror = () => handlers.onError("stream failed");
    return () => source.close();
  }
}
