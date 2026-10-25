// A spoken audio channel from the sidecar to the panel (`agent-feed/sidecar/src/audio/`).
//
// One long-lived audio stream rather than a clip per message: a phone starts playback only from a
// tap, and a clip that ends can let iOS close the audio session, after which the next one does not
// start on a locked screen. So the sidecar keeps one stream playing, silence between messages.

/**
 * `GET /api/audio/stream?listener=<id>&noise=<level>`: AAC (ADTS), paced in real time, a bed of white
 * noise at `level` (0 is silence) with agents' messages over it, for as long as the listener stays.
 *
 * `listener` names the device, so its noise level can change without reconnecting and two
 * connections from one device (a phone probes a stream before playing it) count as one listener.
 * Resuming is connecting again.
 */
export const AUDIO_STREAM_ROUTE = "/api/audio/stream";

/** Noise levels run from 0, silence, to this. */
export const AUDIO_NOISE_LEVEL_MAX = 10;

/**
 * `POST /api/audio/noise`: set a listening device's noise level, heard once what the stream has
 * already sent ahead has played. 404 when that device has no stream open.
 */
export const AUDIO_NOISE_ROUTE = "/api/audio/noise";

export type AudioNoiseRequest = { listener: string; level: number };

/**
 * `POST /api/audio/speak`: say `text` on every audio stream open now, at its next gap. How an agent
 * forwards a message to whoever is listening. Spoken once, then shared by every stream. With no
 * stream open it is refused, 409 `nobody_listening`, and nothing is spoken.
 */
export const AUDIO_SPEAK_ROUTE = "/api/audio/speak";

/** The longest message spoken; a longer one is refused rather than cut, so nothing is half said. */
export const AUDIO_SPEAK_MAX_CHARS = 1_000;

export type AudioSpeakRequest = { text: string };

/** `listeners` is how many streams it went to; `durationMs` how long it plays. */
export type AudioSpeakResponse = { listeners: number; durationMs: number };

/**
 * `GET /api/audio/listeners`: how many audio streams are open now, so an agent can ask before it
 * forwards anything. A stream counts from the moment it connects until it is dropped: a paused
 * player has dropped it, and so has one whose page noticed it was interrupted.
 */
export const AUDIO_LISTENERS_ROUTE = "/api/audio/listeners";

export type AudioListenersResponse = { listeners: number };
