/* Wire types for Send: the panel hands annotations to an agent session over the
 * hub. The hub owns the message and its state; the annotator owns the link from
 * an annotation to the message that carried it, and nothing else. */
import * as z from "zod";
import { SEND_STATES } from "./vocab.ts";

/** Where a message is, from the hub. Mirrors the hub's own states, not a second vocabulary. */
export type SendState = (typeof SEND_STATES)[number];

/** How far along a session is: `reachable` means somebody can answer right now. */
export type RecipientReachability = "reachable" | "offline";

/**
 * One thing the reader can send to.
 *
 * A session a Bot curates. A Bot is the unit the owner curates and the only thing the hub will accept
 * a message addressed to, so every row here is a session and its `address` is the address that
 * reaches it: the Bot's own when the Bot curates one session, and `bot:<id>/<sessionId>` when it
 * curates several. A session in no Bot is not listed at all, since it is not something this can send
 * to. A Bot arrives as a group label over its sessions, through `related`.
 */
export interface Recipient {
  address: string;
  /** The session this row is, or null for a Bot or the owner. */
  session: string | null;
  name: string;
  machine: string | null;
  cwd: string | null;
  reachability: RecipientReachability;
  lastSeenAt: string | null;
  /** The Bot address curating this session, which is also the group label the panel shows it under. */
  related: string[];
}

export const SendRequest = z.object({
  ids: z.array(z.number().int().positive()).min(1, "pick at least one annotation").max(200, "too many annotations for one message"),
  to: z.string().min(1, "pick who to send to"),
});

export const SendQuery = z.object({
  // `?ids=1,2,3`, because a query string has no room for a repeated key the panel would have to
  // build by hand, and this is the only caller. Coerced, because a query value is always a string.
  ids: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((n) => z.coerce.number().int().positive().parse(n.trim()))),
});

/** What Send did, for the panel to show on the annotations it just handed over. */
export interface SendOutcome {
  messageId: string;
  to: string;
  toName: string;
  state: SendState;
  sentAt: string;
  annotationIds: number[];
}

/** One annotation's newest send, with the hub's live state for its message. */
export interface SendInfo {
  annotationId: number;
  messageId: string;
  to: string;
  toName: string;
  state: SendState;
  createdAt: string;
}
