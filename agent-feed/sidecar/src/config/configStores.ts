// The small JSON files this sidecar owns outright, both written through `lockedJsonFile.ts`.
//
// Shared by the stable and dev sidecars, because each names machine-level facts -- projects and
// provider sessions -- rather than one host process's runtime. The files are the authority;
// project directories deliberately receive no mirrored metadata.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const storeDirectory = join(homedir(), "Library", "Application Support", "agentdesk-agent-feed");

/** The curated Bot roster. */
export const botsPath = resolve(process.env.AGENT_FEED_BOTS_PATH?.trim() || join(storeDirectory, "bots.json"));

/**
 * Which sessions the reader archived (ADR-0126). Ours rather than any provider's: Codex keeps its
 * own archived flag in a database this sidecar only reads, and Claude has none.
 */
export const sessionArchivePath = resolve(
  process.env.AGENT_FEED_SESSION_ARCHIVE_PATH?.trim() || join(storeDirectory, "session-archive.json"),
);

/**
 * Web push (`push/`): the VAPID key pair this machine signs pushes with, and the subscriptions it
 * sends to. Holds a private key, so it is written 0600 like the files beside it.
 */
export const webPushPath = resolve(
  process.env.AGENT_FEED_WEB_PUSH_PATH?.trim() || join(storeDirectory, "web-push.json"),
);

/** Which sidecar sends the notifications this machine raises on its own (`push/pushSenderLease.ts`). */
export const webPushSenderPath = `${webPushPath}.sender`;
