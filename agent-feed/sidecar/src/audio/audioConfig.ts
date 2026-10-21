// Where the audio process listens, for the process itself, the sidecar that forwards to it, and the
// panel's dev server that sends the phone's stream to it directly.
//
// Its own small module rather than a field in `config/config.ts`, because the audio process imports
// it: every file the process imports is one whose edit restarts the process and cuts whoever is
// listening, and the sidecar's config reaches half the tree.

/** On loopback only: its callers are the sidecar and the dev server on this Mac. */
export const AUDIO_HOST = "127.0.0.1";

/**
 * The audio process's port is the sidecar's plus this, so the stable host (sidecar 7682) and the
 * dev host (7782) each get their own (7683, 7783) without another variable to keep in step.
 */
export const AUDIO_PORT_OFFSET = 1;

/** The sidecar's default port, as `config/config.ts` reads it. */
const SIDECAR_PORT_DEFAULT = 7682;

/**
 * The speech process's port (`agent-feed/speech/speech_server.py`, which the sidecar sends a Bot
 * session's announcements to) is the sidecar's plus this: 7690 beside the stable host, 7790 beside
 * the dev host.
 */
export const SPEECH_PORT_OFFSET = 8;

/** A port named outright in `name`, or the sidecar's port plus `offset`. */
function portFor(environment: Record<string, string | undefined>, name: string, offset: number): number {
  const explicit = Number(environment[name]);
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65_536) return explicit;
  const sidecar = Number(environment.AGENT_FEED_PORT);
  const base = Number.isInteger(sidecar) && sidecar > 0 && sidecar < 65_536 - offset ? sidecar : SIDECAR_PORT_DEFAULT;
  return base + offset;
}

/** The sidecar's own port: `AGENT_FEED_PORT`, which the host sets, or its default. */
export function sidecarPort(environment: Record<string, string | undefined> = process.env): number {
  return portFor(environment, "AGENT_FEED_PORT", 0);
}

/** `AGENT_FEED_AUDIO_PORT` when set, otherwise the sidecar's port plus `AUDIO_PORT_OFFSET`. */
export function audioPort(environment: Record<string, string | undefined> = process.env): number {
  return portFor(environment, "AGENT_FEED_AUDIO_PORT", AUDIO_PORT_OFFSET);
}

/** `AGENT_FEED_SPEECH_PORT` when set, otherwise the sidecar's port plus `SPEECH_PORT_OFFSET`. */
export function speechPort(environment: Record<string, string | undefined> = process.env): number {
  return portFor(environment, "AGENT_FEED_SPEECH_PORT", SPEECH_PORT_OFFSET);
}
