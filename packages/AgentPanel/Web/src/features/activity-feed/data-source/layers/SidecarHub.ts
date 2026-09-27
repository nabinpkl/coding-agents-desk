/**
 * The agent messaging hub, as the panel reaches it: through the sidecar's `/api/hub/*` routes.
 *
 * Its own file rather than a block on `SidecarDataSource`, because these five calls are about the
 * hub and nothing else on the data source is: the hub is a different service on a different
 * machine, with its own store, and the panel never holds a token for it. The sidecar speaks as
 * `human` on the panel's behalf, which is the same trust the panel already has over this
 * machine's sessions.
 */

import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { parse } from "@/features/activity-feed/data-source/sidecarRoutes";

export interface HubHandle {
  /** Who the hub can address right now, with reachability. */
  directory(): Promise<DirectoryEntry[]>;
  /** The threads the owner is part of, newest activity first. */
  threads(): Promise<Message[][]>;
  /** Starts a thread as the owner. `to` is an address or a directory name. */
  send(input: { to: string; body: string; kind?: "request" | "notice" }): Promise<Message>;
  /** Answers a message in its own thread, which is how the owner replies in the inbox. */
  reply(messageId: string, body: string): Promise<Message>;
  /** Cancels a message still queued for a recipient that is not there yet. */
  cancel(messageId: string): Promise<Message>;
}

export class SidecarHub implements HubHandle {
  constructor(private readonly transport: AgentHttpTransport) {}

  async directory(): Promise<DirectoryEntry[]> {
    return parse<DirectoryEntry[]>(await this.transport.request("GET", "/api/hub/directory"));
  }

  async threads(): Promise<Message[][]> {
    return parse<Message[][]>(await this.transport.request("GET", "/api/hub/threads"));
  }

  async send(input: { to: string; body: string; kind?: "request" | "notice" }): Promise<Message> {
    return parse<Message>(
      await this.transport.request("POST", "/api/hub/messages", {
        body: { to: input.to, body: input.body, ...(input.kind ? { kind: input.kind } : {}) },
      }),
    );
  }

  async reply(messageId: string, body: string): Promise<Message> {
    return parse<Message>(
      await this.transport.request("POST", "/api/hub/messages", { body: { inReplyTo: messageId, body } }),
    );
  }

  async cancel(messageId: string): Promise<Message> {
    return parse<Message>(
      await this.transport.request("POST", `/api/hub/messages/${encodeURIComponent(messageId)}/cancel`),
    );
  }
}
