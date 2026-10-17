// Agent messaging: the hub's wire shapes, shared by the hub, the relay child, the sidecar and the
// panel. See docs/agent-messaging.md for the design these types carry.

/**
 * Who can send or receive.
 *
 * `human` is the owner. A Bot is the only other thing a message can be addressed to, because a Bot
 * is the unit of curation: the owner decides which agents exist by putting their sessions in one, so
 * a session in no Bot is not addressable by anyone and does not take part in messaging at all. That
 * is the whole point of the grouping, since an uncurated session is exactly the noise it removes.
 *
 * `bot:<botId>` addresses a Bot, which resolves to the one session it names when it has exactly
 * one. `bot:<botId>/<sessionId>` names which session of a multi-session Bot should receive it,
 * because a Bot with several sessions does not say which of them should get a message and guessing
 * is how an instruction lands in the wrong agent. There is no bare `<source>:<sessionId>` address:
 * a session on its own says a run of a process but not which agent it belongs to, and that is the
 * question the Bot answers. The disambiguation happens through the Bot-session relationship, so an
 * address cannot name a session that is not a member of the Bot it claims.
 *
 * A message's `from` and `deliveredTo` are session addresses rather than these, because they record
 * which run actually spoke and which run actually received it. See `SessionAddress`.
 */
export type MessageAddress = "human" | `bot:${string}` | `bot:${string}/${string}`;

/**
 * One live run of one agent, as the directory lists it and as a message records having received one.
 *
 * This is identity, not a destination: nothing is addressed here. A session is reachable only
 * through the Bot it belongs to, so `to` is a `MessageAddress` and this type appears on `from`,
 * `deliveredTo` and the directory's session entries.
 */
export type SessionAddress = `claude:${string}` | `opencode:${string}`;

/** The agent runtimes v1 can address, in the order the directory lists them. */
export type MessagingSource = "claude" | "opencode";

/**
 * The kinds a sender chooses, by what it wants back. None of them carries authority: that is
 * `fromKind`, which the hub stamps. `reply` is not among them because the hub assigns it to
 * whatever answers another message.
 */
export const SENT_MESSAGE_KINDS = ["request", "question", "report"] as const;

export type SentMessageKind = (typeof SENT_MESSAGE_KINDS)[number];

export type MessageKind = SentMessageKind | "reply";

/** What a sending agent is told each kind means, so every hub_send tool describes them alike. */
export const SENT_MESSAGE_KIND_HELP =
  'What you want back. "report": information for the recipient\'s judgement, such as findings, review results or status; it asks for no action and takes no reply. ' +
  '"question": something you need to know; the recipient answers and changes nothing. ' +
  '"request": something you want done; the recipient acts only within the task its user gave it, and replies with what it did or that it declined. ' +
  "None of these gives your message the owner's authority.";

export type SenderKind = "human" | "agent";

/**
 * Where one message stands.
 *
 * `pushed` is transient: the hub wrote it to a session's stream and waits for the relay child to
 * confirm it reached the session. A dropped stream turns `pushed` back into `queued`.
 */
export type MessageState = "queued" | "pushed" | "delivered" | "answered" | "expired" | "cancelled";

/** A record in some other app, carried and never read by the hub. */
export interface MessageRef {
  app: string;
  kind: string;
  id: string;
  url?: string;
}

export interface Message {
  id: string;
  threadId: string;
  inReplyTo: string | null;
  /** The session that spoke, or `human`. */
  from: SessionAddress | "human";
  fromKind: SenderKind;
  to: MessageAddress;
  kind: MessageKind;
  body: string;
  refs: MessageRef[];
  /** Consecutive agent-sent messages in the thread since the last human one, this one included. */
  hops: number;
  state: MessageState;
  /** The session `to` resolved to when the message was accepted, or null when addressed to the owner. */
  toSession: SessionAddress | null;
  /** The session it reached, or `human` when the owner was the recipient. Null while still held. */
  deliveredTo: SessionAddress | "human" | null;
  deliveredAt: string | null;
  answeredBy: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SendMessageRequest {
  /** The sender: `human` for a human surface, or the session address a relay child speaks for. */
  as: SessionAddress | "human";
  /** Omitted on a reply: a reply always goes to the sender of `inReplyTo`. */
  to?: MessageAddress;
  kind: SentMessageKind;
  body: string;
  refs?: MessageRef[];
  inReplyTo?: string;
}

export interface ReplyMessageRequest {
  as: SessionAddress | "human";
  inReplyTo: string;
  body: string;
  refs?: MessageRef[];
}

export type DirectoryReachability =
  | "reachable"
  /** The session is running but was started without the relay channel, so nothing can be pushed to it. */
  | "no-channel"
  | "offline";

export interface DirectoryEntry {
  address: MessageAddress;
  /**
   * The session this entry is, when it is a session rather than a Bot or the owner.
   *
   * Needed because a single-session Bot's address is the Bot's own, so the address alone does not say
   * which run it is. A client that has a session id in hand -- the relay child sending as itself, a
   * panel following a thread -- matches on this to find the entry, rather than guessing from a name.
   */
  session: SessionAddress | null;
  name: string;
  machine: string | null;
  reachability: DirectoryReachability;
  lastSeenAt: string | null;
  /**
   * For a session, the Bots it belongs to; for a Bot, the member sessions to send to instead.
   *
   * This is how a label stays useful now that it cannot be addressed: the directory hands a reader
   * the sessions under a Bot, and those are the addresses a message goes to.
   */
  related: MessageAddress[];
  cwd: string | null;
}

/** One Bot as a machine's sidecar publishes it. */
export interface PublishedBot {
  botId: string;
  name: string;
  path: string;
  /**
   * The session ids attached to this Bot, each prefixed by its source (`claude:<id>` or
   * `opencode:<id>`). A Bot can hold sessions from both, so the prefix is what keeps one
   * runtime's ids from being resolved as another's.
   */
  sessionIds: string[];
}

export interface PublishBotsRequest {
  bots: PublishedBot[];
}

/** What a relay child's stream carries, as SSE `data:` lines. */
export type HubStreamEvent =
  | { type: "hello"; address: SessionAddress; channel: boolean }
  | { type: "message"; message: Message; fromName: string }
  | { type: "directive"; id: string; kind: "rename-bracket"; task: string };
