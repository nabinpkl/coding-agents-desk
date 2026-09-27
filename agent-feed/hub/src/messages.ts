// Sending, replying and delivering. Every rule a message must pass lives here, and so does the one
// place that decides which session a queued message goes to.

import type {
  HubStreamEvent,
  Message,
  MessageAddress,
  MessagingSource,
  MessageRef,
  SenderKind,
} from "@agentdesk/agent-feed-wire";
import type { Principal } from "@/config";
import { Directory, isAddress, sessionAddress, sessionSource } from "@/directory";
import { publicMessage, type HubStore, type StoredMessage } from "@/store";

export const LIMITS = {
  bodyBytes: 32 * 1024,
  refsBytes: 4 * 1024,
  maxHops: 6,
  ratePerWindow: 20,
  rateWindowMs: 10 * 60 * 1000,
  /** The owner's surfaces send when a person does, so their ceiling is far above ordinary use. */
  humanPerWindow: 60,
  humanWindowMs: 10 * 60 * 1000,
  threadMessages: 200,
  ttlMs: 7 * 24 * 3600 * 1000,
} as const;

export class InvalidMessage extends Error {}
export class Forbidden extends Error {}
export class NotFound extends Error {}
export class Refused extends Error {}
export class RateLimited extends Error {
  /** What a refused caller should wait, when the refusal came from a budget rather than a rule. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "RateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A live stream to one session: where pushes go. */
export interface SessionStream {
  id: string;
  push(event: HubStreamEvent): void;
}

export interface SendInput {
  as?: unknown;
  to?: unknown;
  kind?: unknown;
  body?: unknown;
  refs?: unknown;
  inReplyTo?: unknown;
}

const FORGED_ENVELOPE = /<\/?\s*channel\b/i;

function checkBody(body: unknown): string {
  if (typeof body !== "string" || body.trim() === "") throw new InvalidMessage("body must be non-empty text");
  if (new TextEncoder().encode(body).length > LIMITS.bodyBytes) throw new InvalidMessage(`body is over ${LIMITS.bodyBytes} bytes`);
  if (FORGED_ENVELOPE.test(body)) throw new InvalidMessage("body contains a <channel> tag; the hub will not carry a forged envelope");
  return body;
}

function checkRefs(refs: unknown): MessageRef[] {
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) throw new InvalidMessage("refs must be an array");
  const out = refs.map((r): MessageRef => {
    const ref = r as Record<string, unknown>;
    if (typeof ref.app !== "string" || typeof ref.kind !== "string" || typeof ref.id !== "string") throw new InvalidMessage("each ref needs app, kind and id strings");
    if (ref.url !== undefined && typeof ref.url !== "string") throw new InvalidMessage("ref url must be a string");
    return { app: ref.app, kind: ref.kind, id: ref.id, ...(typeof ref.url === "string" ? { url: ref.url } : {}) };
  });
  if (JSON.stringify(out).length > LIMITS.refsBytes) throw new InvalidMessage(`refs are over ${LIMITS.refsBytes} bytes`);
  return out;
}

export class Messages {
  readonly directory: Directory;
  private readonly streams = new Map<MessageAddress, SessionStream>();

  constructor(private readonly store: HubStore, private readonly clock: () => Date = () => new Date()) {
    this.directory = new Directory(store);
  }

  /** Checks that a principal may speak as an address, and says which kind of sender that is. */
  private sender(principal: Principal, as: unknown): { from: MessageAddress; fromKind: SenderKind } {
    if (!isAddress(as)) throw new InvalidMessage("as must be an address");
    if (as === "human") {
      if (!principal.human) throw new Forbidden(`${principal.label} may not send as human`);
      return { from: as, fromKind: "human" };
    }
    if (!sessionAddress(as)) throw new InvalidMessage("only human or a session can send");
    const session = this.store.getSession(as);
    if (!principal.machine || !session || session.machine !== principal.machine || !session.connected) {
      throw new Forbidden(`${principal.label} has no live stream for ${as}`);
    }
    return { from: as, fromKind: "agent" };
  }

  send(principal: Principal, input: SendInput): Message {
    const { from, fromKind } = this.sender(principal, input.as);
    const body = checkBody(input.body);
    const refs = checkRefs(input.refs);
    const now = this.clock();
    const id = Bun.randomUUIDv7();

    let to: MessageAddress;
    let kind: StoredMessage["kind"];
    let threadId = id;
    let parent: StoredMessage | undefined;
    if (input.inReplyTo !== undefined) {
      if (typeof input.inReplyTo !== "string") throw new InvalidMessage("inReplyTo must be a message id");
      parent = this.store.getMessage(input.inReplyTo);
      if (!parent) throw new NotFound(`message ${input.inReplyTo} not found`);
      if (parent.kind === "notice") throw new Refused("a notice takes no reply");
      if (from !== parent.to && from !== parent.deliveredTo) throw new Forbidden(`${from} did not receive message ${parent.id}`);
      to = parent.from;
      kind = "reply";
      threadId = parent.threadId;
    } else {
      if (!isAddress(input.to)) throw new InvalidMessage("to must be an address");
      if (input.kind !== "request" && input.kind !== "notice") throw new InvalidMessage("kind must be request or notice");
      to = input.to;
      kind = input.kind;
      // Agent to agent is Bot to Bot. An agent opening a new conversation with another agent names
      // an active Bot rather than a session, because a session id names one run of a process that is
      // gone the moment it restarts, while a Bot is whatever that agent is right now. "Active" means
      // the Bot is in the published list, which the exists() check below already enforces: an
      // unpublished Bot is not addressable, so a caller can only ever reach a Bot some machine is
      // currently publishing.
      //
      // Replies are exempt, and have to be: a reply's recipient is whoever the message came from,
      // which is a session, and following a thread back to its sender is not opening a new
      // conversation. So this sits in the new-send branch only, and only for an agent sender.
      if (fromKind === "agent" && to !== "human" && !to.startsWith("bot:")) {
        throw new Refused("agent to agent is bot to bot: name an active bot (bot:<id>) from hub_directory, not a session");
      }
    }
    if (to === from) throw new Refused("a session cannot message itself");
    if (!this.directory.exists(to)) throw new NotFound(`no such address: ${to}`);

    const hops = fromKind === "human" ? 0 : parent && parent.fromKind === "agent" ? parent.hops + 1 : 1;
    if (hops > LIMITS.maxHops) {
      throw new Refused(`thread has had ${LIMITS.maxHops} agent messages in a row; send to human and ask how to proceed`);
    }
    if (fromKind === "agent") {
      const since = new Date(now.getTime() - LIMITS.rateWindowMs).toISOString();
      if (this.store.sentSince(from, since) >= LIMITS.ratePerWindow) throw new RateLimited(`${from} sent ${LIMITS.ratePerWindow} messages in 10 minutes`);
    } else {
      // The owner's own surfaces get a budget too, and a far more generous one. They send when a
      // person does: a panel reply, an annotator Send. Leaving the human path unlimited meant the
      // one principal that can post as the owner was the one a leaked token could spam from, with
      // nothing counting. Sixty in ten minutes is far above a person typing and far below a loop.
      const since = new Date(now.getTime() - LIMITS.humanWindowMs).toISOString();
      if (this.store.sentSince(from, since) >= LIMITS.humanPerWindow) {
        throw new RateLimited(`${from} sent ${LIMITS.humanPerWindow} messages in 10 minutes`);
      }
    }
    if (parent && this.store.threadSize(threadId) >= LIMITS.threadMessages) throw new Refused(`thread is at ${LIMITS.threadMessages} messages; start a new one`);

    const toHuman = to === "human";
    const bots = sessionSource(to) ? this.directory.botsOf(to) : [];
    const fallbackBot = bots[0] ? (`bot:${bots[0]!.botId}` as MessageAddress) : null;
    const saved = this.store.transaction(() => {
      const row = this.store.insertMessage({
        id,
        threadId,
        inReplyTo: parent?.id ?? null,
        from,
        fromKind,
        to,
        fallbackBot,
        kind,
        body,
        refs,
        hops,
        state: toHuman ? "delivered" : "queued",
        deliveredTo: toHuman ? "human" : null,
        deliveredAt: toHuman ? now.toISOString() : null,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + LIMITS.ttlMs).toISOString(),
      });
      if (parent && parent.kind === "request") this.store.markAnswered(parent.id, id);
      return row;
    });
    this.pump();
    return publicMessage(this.store.getMessage(saved.id) ?? saved);
  }

  cancel(principal: Principal, id: string): Message {
    const message = this.store.getMessage(id);
    if (!message) throw new NotFound(`message ${id} not found`);
    this.sender(principal, message.from);
    if (!this.store.cancel(id)) throw new Refused(`message ${id} is ${message.state}; only a queued message can be cancelled`);
    return publicMessage(this.store.getMessage(id)!);
  }

  get(id: string): Message {
    const message = this.store.getMessage(id);
    if (!message) throw new NotFound(`message ${id} not found`);
    return publicMessage(message);
  }

  thread(id: string): Message[] {
    const messages = this.store.thread(id);
    if (messages.length === 0) throw new NotFound(`thread ${id} not found`);
    return messages.map(publicMessage);
  }

  threadsFor(address: MessageAddress, limit = 50): Message[][] {
    const bots = this.directory.botsOf(address).map((b) => `bot:${b.botId}` as MessageAddress);
    return this.store.threadsFor([address, ...bots], limit).map((t) => t.map(publicMessage));
  }

  /** Requests and notices that reached a session, or wait for it, and are not answered yet. */
  inbox(address: MessageAddress): Message[] {
    const bots = this.directory.botsOf(address).map((b) => `bot:${b.botId}` as MessageAddress);
    return this.store.openFor(address, bots).filter((m) => m.kind !== "reply" || m.state !== "answered").map(publicMessage);
  }

  // Streams and delivery

  connect(principal: Principal, session: { source: MessagingSource; sessionId: string; channel: boolean; cwd: string; title: string }, stream: SessionStream): MessageAddress {
    if (!principal.machine) throw new Forbidden(`${principal.label} speaks for no machine`);
    if (!/^[0-9a-zA-Z_-]{1,128}$/.test(session.sessionId)) throw new InvalidMessage("session must be a session id");
    const address = `${session.source}:${session.sessionId}` as MessageAddress;
    const previous = this.streams.get(address);
    if (previous) this.store.requeueStream(previous.id);
    this.streams.set(address, stream);
    this.store.upsertSession({
      address,
      machine: principal.machine,
      cwd: session.cwd,
      title: session.title,
      channel: session.channel,
      connected: true,
      lastSeen: this.clock().toISOString(),
    });
    stream.push({ type: "hello", address, channel: session.channel });
    this.pump();
    return address;
  }

  disconnect(address: MessageAddress, streamId: string): void {
    if (this.streams.get(address)?.id !== streamId) return;
    this.streams.delete(address);
    this.store.requeueStream(streamId);
    this.store.setConnected(address, false, this.clock().toISOString());
    this.pump();
  }

  confirm(principal: Principal, id: string, streamId: string): Message {
    const message = this.store.getMessage(id);
    if (!message) throw new NotFound(`message ${id} not found`);
    if (!message.deliveredTo) throw new Refused(`message ${id} was not pushed`);
    this.sender(principal, message.deliveredTo);
    if (!this.store.markDelivered(id, streamId, this.clock().toISOString())) throw new Refused(`message ${id} is not waiting on stream ${streamId}`);
    return publicMessage(this.store.getMessage(id)!);
  }

  publishBots(principal: Principal, machine: string, bots: Parameters<HubStore["replaceBots"]>[1]): void {
    if (principal.machine !== machine) throw new Forbidden(`${principal.label} may not publish Bots for ${machine}`);
    this.store.replaceBots(machine, bots, this.clock().toISOString());
    this.pump();
  }

  expire(): number {
    return this.store.expire(this.clock().toISOString());
  }

  /** Where a queued message should go now, or null to keep holding it. */
  private target(message: StoredMessage): MessageAddress | null {
    if (message.to.startsWith("bot:")) return this.directory.resolveBot(message.to);
    if (this.directory.reachable(message.to) && this.streams.has(message.to)) return message.to;
    return message.fallbackBot ? this.directory.resolveBot(message.fallbackBot) : null;
  }

  /** Pushes every queued message that has somewhere to go, oldest first. */
  pump(): void {
    for (const message of this.store.queued()) {
      const target = this.target(message);
      if (!target) continue;
      const stream = this.streams.get(target);
      if (!stream) continue;
      this.store.markPushed(message.id, stream.id, target);
      const pushed = this.store.getMessage(message.id)!;
      stream.push({ type: "message", message: publicMessage(pushed), fromName: this.directory.nameOf(message.from) });
    }
  }
}
