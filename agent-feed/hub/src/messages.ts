// Sending, replying and delivering. Every rule a message must pass lives here, and so does the one
// place that decides which session a queued message goes to.

import type {
  HubStreamEvent,
  Message,
  MessageAddress,
  MessagingSource,
  MessageRef,
  SenderKind,
  SessionAddress,
} from "@agentdesk/agent-feed-wire";
import { SENT_MESSAGE_KINDS, type SentMessageKind } from "@agentdesk/agent-feed-wire";
import type { Principal } from "@/config";
import { botAddress, Directory, isAddress, memberAddress, sessionAddress } from "@/directory";
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

function isSentKind(kind: unknown): kind is SentMessageKind {
  return (SENT_MESSAGE_KINDS as readonly unknown[]).includes(kind);
}

/**
 * A <channel> tag in any spelling a model would read as one, opening or closing. Matched on a
 * normalised copy, because a pattern over the raw text slips: "< /channel>" got past
 * `<\/?\s*channel` (2026-10-17), and a fullwidth "＜/channel＞" or a zero-width character inside
 * the word would get past this one. NFKC folds the lookalike brackets onto "<", every invisible
 * character goes (Unicode's own classes, not a list of the ones thought of), and whitespace is
 * allowed on both sides of the slash.
 */
const FORGED_ENVELOPE = /<\s*\/?\s*channel\b/i;
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

function holdsEnvelopeTag(text: string): boolean {
  return FORGED_ENVELOPE.test(text.normalize("NFKC").replace(INVISIBLE, ""));
}

function checkBody(body: unknown): string {
  if (typeof body !== "string" || body.trim() === "") throw new InvalidMessage("body must be non-empty text");
  if (new TextEncoder().encode(body).length > LIMITS.bodyBytes) throw new InvalidMessage(`body is over ${LIMITS.bodyBytes} bytes`);
  if (holdsEnvelopeTag(body)) throw new InvalidMessage("body contains a <channel> tag; the hub will not carry a forged envelope");
  return body;
}

function checkRefs(refs: unknown): MessageRef[] {
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) throw new InvalidMessage("refs must be an array");
  const out = refs.map((r): MessageRef => {
    const ref = r as Record<string, unknown>;
    if (typeof ref.app !== "string" || typeof ref.kind !== "string" || typeof ref.id !== "string") throw new InvalidMessage("each ref needs app, kind and id strings");
    if (ref.url !== undefined && typeof ref.url !== "string") throw new InvalidMessage("ref url must be a string");
    // Refs are written into the same envelope as the body, so they are held to the same check.
    if ([ref.app, ref.kind, ref.id, ref.url ?? ""].some((field) => holdsEnvelopeTag(field as string))) {
      throw new InvalidMessage("a ref contains a <channel> tag; the hub will not carry a forged envelope");
    }
    return { app: ref.app, kind: ref.kind, id: ref.id, ...(typeof ref.url === "string" ? { url: ref.url } : {}) };
  });
  if (JSON.stringify(out).length > LIMITS.refsBytes) throw new InvalidMessage(`refs are over ${LIMITS.refsBytes} bytes`);
  return out;
}

export class Messages {
  readonly directory: Directory;
  private readonly streams = new Map<SessionAddress, SessionStream>();

  constructor(private readonly store: HubStore, private readonly clock: () => Date = () => new Date()) {
    this.directory = new Directory(store);
  }

  /**
   * The one session a Bot address reaches, or why it reaches none.
   *
   * This is the single place a destination becomes a session, and it never guesses. A Bot that
   * curates exactly one session is that session, which is the common case and needs no ceremony. A
   * Bot curating several does not say which of them should receive a message, so the address has to
   * name one and it has to be a member: picking the newest reachable member instead is how an
   * instruction addressed to an agent landed in whichever of its sessions reconnected last, by
   * 74 milliseconds. A session named under a Bot it is not a member of is refused rather than
   * resolved, so an address cannot reach outside the curation it claims.
   */
  private resolve(address: MessageAddress): SessionAddress {
    const bot = this.directory.bot(address);
    if (!bot) throw new NotFound(`no such Bot: ${address}`);
    const members = this.directory.membersOf(bot);
    if (members.length === 0) {
      throw new Refused(`${bot.name} curates no sessions right now, so there is nothing to send to`);
    }
    const named = this.directory.namedSession(address);
    if (address.includes("/")) {
      if (!named) {
        throw new Refused(`${bot.name} does not curate that session; it curates ${members.join(", ")}`);
      }
      return named;
    }
    if (members.length > 1) {
      // Naming one is the sender's job, and the directory lists them so they can be chosen.
      throw new Refused(
        `${bot.name} curates ${members.length} sessions, so name the one to send to: bot:${bot.botId}/<sessionId> (${members.join(", ")})`,
      );
    }
    return members[0]!;
  }

  /**
   * The address that reaches a session, used when a reply names its sender.
   *
   * A reply carries an address rather than a session, since `to` is what a reader resolves later. A
   * session its Bot curates alone is that Bot's own address, and the qualified form otherwise. A
   * session the owner has since taken out of every Bot has no address at all, and the reply is
   * refused rather than assembled into one that resolves to nothing: uncurated means not a
   * participant, and a Bot of one invented purely to carry the reply would be a curation nobody made.
   */
  private addressFor(session: SessionAddress): MessageAddress {
    const bot = this.directory.botsOf(session)[0];
    if (!bot) {
      throw new Refused(`${session} is in no published Bot, so it cannot be reached; put it in one to let it take part`);
    }
    return this.directory.membersOf(bot).length === 1 ? botAddress(bot) : memberAddress(bot, session);
  }

  /** Checks that a principal may speak as an address, and says which kind of sender that is. */
  private sender(principal: Principal, as: unknown): { from: SessionAddress | "human"; fromKind: SenderKind } {
    if (as === "human") {
      if (!principal.human) throw new Forbidden(`${principal.label} may not send as human`);
      return { from: "human", fromKind: "human" };
    }
    const checked = this.sessionSender(principal, as);
    return { from: checked.session, fromKind: "agent" };
  }

  /**
   * Checks that a principal may act as a live session, and says which machine holds its stream.
   *
   * The same guard sending answers to, so a tool that acts for a session refuses exactly the
   * sessions a message may not speak as: no live stream, another machine's, or in no Bot.
   */
  checkSession(principal: Principal, address: SessionAddress): { machine: string } {
    return { machine: this.sessionSender(principal, address).machine };
  }

  private sessionSender(principal: Principal, as: unknown): { session: SessionAddress; machine: string } {
    const session = sessionAddress(as);
    if (!session) throw new InvalidMessage("as must be \"human\" or a session id");
    const row = this.store.getSession(session);
    if (!row || !row.connected) {
      throw new Forbidden(`${principal.label} has no live stream for ${session}`);
    }
    // Service tokens speak for their own machine's sessions. The owner carries no machine and may
    // speak as a session on any of them; the curation check below still applies either way.
    if (!principal.owner && (!principal.machine || row.machine !== principal.machine)) {
      throw new Forbidden(`${principal.label} has no live stream for ${session}`);
    }
    // A session in no Bot does not take part in messaging. The Bot grouping is the owner's curation
    // of which agents are reachable, so an uncurated session is not a participant even as a sender,
    // which is what stops 55 uncurated sessions from putting messages in the owner's inbox.
    if (this.directory.botsOf(session).length === 0) {
      throw new Refused(`${session} is in no published Bot, so it does not take part in messaging; put it in one to include it`);
    }
    return { session, machine: row.machine };
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
      if (parent.kind === "report") throw new Refused("a report takes no reply; to answer it, send a message of your own");
      // A reply names the sender of what it answers, so it is exempt from the Bot-member rule on the
      // recipient side: a session the owner deliberately involved must be able to answer even if the
      // owner has since taken it out of a Bot. The sender check in `sender` is the guard that matters,
      // since a session in no Bot cannot open a thread in the first place.
      if (from !== parent.deliveredTo && from !== parent.from) throw new Forbidden(`${from} did not receive message ${parent.id}`);
      to = parent.from === "human" ? "human" : this.addressFor(parent.from);
      kind = "reply";
      threadId = parent.threadId;
    } else {
      if (!isAddress(input.to)) {
        throw new InvalidMessage('to must be "human" or a Bot address: "bot:<id>", or "bot:<id>/<sessionId>" when the Bot curates several sessions');
      }
      if (!isSentKind(input.kind)) throw new InvalidMessage(`kind must be one of ${SENT_MESSAGE_KINDS.join(", ")}`);
      to = input.to;
      kind = input.kind;
    }
    // Resolving here rather than at delivery is what makes the wait honest: a message addressed to a
    // session that is down names that session and waits for it, instead of being rerouted somewhere the
    // sender did not choose. It also settles the self-delivery case, since the resolved session is known
    // before the message is ever queued.
    const toSession = to === "human" ? null : this.resolve(to);
    if (toSession === from) throw new Refused("a session cannot message itself");

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
    const saved = this.store.transaction(() => {
      const row = this.store.insertMessage({
        id,
        threadId,
        inReplyTo: parent?.id ?? null,
        from,
        fromKind,
        to,
        toSession,
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
      // A request and a question are owed an answer; the reply settles them.
      if (parent && (parent.kind === "request" || parent.kind === "question")) this.store.markAnswered(parent.id, id);
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

  threadsFor(session: SessionAddress, limit = 50): Message[][] {
    const bots = this.directory.botsOf(session).map((b) => botAddress(b));
    return this.store.threadsFor([session], bots, limit).map((t) => t.map(publicMessage));
  }

  /** Messages that reached a session, or wait for it, and are not answered yet. */
  inbox(session: SessionAddress): Message[] {
    return this.store.openFor(session).filter((m) => m.kind !== "reply" || m.state !== "answered").map(publicMessage);
  }

  // Streams and delivery

  connect(principal: Principal, session: { source: MessagingSource; sessionId: string; channel: boolean; cwd: string; title: string }, stream: SessionStream): SessionAddress {
    if (!principal.machine) throw new Forbidden(`${principal.label} speaks for no machine`);
    if (!/^[0-9a-zA-Z_-]{1,128}$/.test(session.sessionId)) throw new InvalidMessage("session must be a session id");
    const address = `${session.source}:${session.sessionId}` as SessionAddress;
    const previous = this.streams.get(address);
    // A machine reconnecting replaces its own stream. Another machine claiming an address that is
    // live elsewhere is refused: session ids are random per launch, so two machines naming one is a
    // bug in whoever chose the id, and taking the address over would silently hand the first
    // machine's queued messages to the second. Once the first stream ends, the address is free, so a
    // session that genuinely moves between machines still moves.
    const holder = previous ? this.store.getSession(address) : undefined;
    if (previous && holder?.connected && holder.machine !== principal.machine) {
      throw new Refused(`${address} is live on ${holder.machine}; ${principal.label} cannot open a second stream for it`);
    }
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

  disconnect(address: SessionAddress, streamId: string): void {
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

  /**
   * Where a queued message should go now, or null to keep holding it.
   *
   * The session its address resolved to when it was accepted, and nothing else. Resolving once at
   * acceptance rather than again here is what makes a wait honest: a Bot's membership can change while
   * a message sits queued, and re-resolving would let it move to a session the sender never named,
   * which is the same surprise as the old Bot fallback that resolved to whichever member was newest.
   * The cost is stated rather than hidden: a message to a session that has ended waits for that run
   * until it returns or the message expires.
   */
  private target(message: StoredMessage): SessionAddress | null {
    const session = message.toSession;
    if (!session) return null;
    return this.directory.reachable(session) && this.streams.has(session) ? session : null;
  }

  /** Pushes one event onto a live stream, or answers false when nothing holds it. */
  direct(address: SessionAddress, event: HubStreamEvent): boolean {
    const stream = this.streams.get(address);
    if (!stream) return false;
    stream.push(event);
    return true;
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
