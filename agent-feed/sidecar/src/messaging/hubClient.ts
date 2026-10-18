// The agent messaging hub, as the relay child and the sidecar reach it: HTTPS behind Cloudflare
// Access, authenticated with this machine's service token.
//
// The token lives in one file per machine, `~/.config/agentdesk-relay/hub.env` (mode 0600):
//   HUB_URL=https://relay.example.com
//   HUB_MACHINE=mac
//   CF_ACCESS_CLIENT_ID=...
//   CF_ACCESS_CLIENT_SECRET=...

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubStreamEvent } from "@agentdesk/agent-feed-wire";

export interface HubSettings {
  url: string;
  machine: string;
  clientId: string;
  clientSecret: string;
}

export const HUB_ENV_FILE = join(homedir(), ".config", "agentdesk-relay", "hub.env");

/** The hub settings, or a sentence saying what is missing. */
export function loadHubSettings(file: string = process.env.AGENTDESK_HUB_ENV ?? HUB_ENV_FILE): HubSettings | string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return `hub not configured: ${file} is missing`;
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const missing = ["HUB_URL", "HUB_MACHINE", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].filter(
    (k) => !values.get(k),
  );
  if (missing.length > 0) return `hub not configured: ${file} lacks ${missing.join(", ")}`;
  return {
    url: values.get("HUB_URL")!.replace(/\/+$/, ""),
    machine: values.get("HUB_MACHINE")!,
    clientId: values.get("CF_ACCESS_CLIENT_ID")!,
    clientSecret: values.get("CF_ACCESS_CLIENT_SECRET")!,
  };
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HubClient {
  constructor(readonly settings: HubSettings) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "cf-access-client-id": this.settings.clientId,
      "cf-access-client-secret": this.settings.clientSecret,
      ...extra,
    };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.settings.url}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400)
      throw new HubError(response.status, "Access refused the service token (redirect to login)");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new HubError(response.status, `hub answered ${response.status} with non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok)
      throw new HubError(
        response.status,
        (data as { error?: string } | null)?.error ?? `hub answered ${response.status}`,
      );
    return data as T;
  }

  /**
   * One stream connection. Resolves when the stream ends; rejects when it cannot open.
   * Each event carries the stream id the hub wants back on a delivery confirmation.
   */
  async stream(
    query: Record<string, string>,
    onEvent: (event: HubStreamEvent & { streamId: string }) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.settings.url}/v1/stream?${new URLSearchParams(query)}`, {
      headers: this.headers({ accept: "text/event-stream" }),
      redirect: "manual",
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new HubError(response.status, `stream refused (${response.status}): ${text.slice(0, 200)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data) await onEvent(JSON.parse(data) as HubStreamEvent & { streamId: string });
      }
    }
  }
}
