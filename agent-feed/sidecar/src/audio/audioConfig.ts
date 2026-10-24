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

/** `AGENT_FEED_AUDIO_PORT` when set, otherwise the sidecar's port plus `AUDIO_PORT_OFFSET`. */
export function audioPort(environment: Record<string, string | undefined> = process.env): number {
  const explicit = Number(environment.AGENT_FEED_AUDIO_PORT);
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65_536) return explicit;
  const sidecar = Number(environment.AGENT_FEED_PORT);
  const base = Number.isInteger(sidecar) && sidecar > 0 && sidecar < 65_535 ? sidecar : SIDECAR_PORT_DEFAULT;
  return base + AUDIO_PORT_OFFSET;
}
