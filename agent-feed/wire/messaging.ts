// Agent messaging: the hub's wire shapes, shared by the hub, the relay child, the sidecar and the
// panel. See docs/agent-messaging.md for the design these types carry.

/**
 * Who can send or receive.
 *
 * `human` is the owner. `claude:<sessionId>` and `opencode:<sessionId>` are one live agent session
 * on one machine, and they are what a message is addressed to.
 *
 * `bot:<botId>` is an agent-desk Bot, and it is a LABEL rather than a destination: it names the set
 * of sessions belonging to one agent, and the directory lists it so a reader sees that grouping. It
 * is in this type because the directory and a message's `to` field carry the shape, not because
 * anything can be sent to one -- the hub refuses that, since a Bot does not say which of its sessions
 * should receive a message.
 */
export type MessageAddress = "human" | `claude:${string}` | `opencode:${string}` | `bot:${string}`;

/** The agent runtimes v1 can address, in the order the directory lists them. */
export type MessagingSource = "claude" | "opencode";

export type MessageKind = "request" | "notice" | "reply";

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
  from: MessageAddress;
  fromKind: SenderKind;
  to: MessageAddress;
  kind: MessageKind;
  body: string;
  refs: MessageRef[];
  /** Consecutive agent-sent messages in the thread since the last human one, this one included. */
  hops: number;
  state: MessageState;
  /** The session it reached, which is always a session. Null while the message is still held. */
  deliveredTo: MessageAddress | null;
  deliveredAt: string | null;
  answeredBy: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SendMessageRequest {
  /** The sender: `human` for a human surface, `<source>:<id>` for a relay child speaking for its session. */
  as: MessageAddress;
  /** Omitted on a reply: a reply always goes to the sender of `inReplyTo`. Never a `bot:` address. */
  to?: MessageAddress;
  kind: "request" | "notice";
  body: string;
  refs?: MessageRef[];
  inReplyTo?: string;
}

export interface ReplyMessageRequest {
  as: MessageAddress;
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
  | { type: "hello"; address: MessageAddress; channel: boolean }
  | { type: "message"; message: Message; fromName: string };
