// A spoken audio channel from the sidecar to the panel (`agent-feed/sidecar/src/audio/`).
//
// One long-lived audio stream rather than a clip per message: a phone starts playback only from a
// tap, and a clip that ends can let iOS close the audio session, after which the next one does not
// start on a locked screen. So the sidecar keeps one stream playing, silence between messages.

/**
 * `GET /api/audio/test-stream`: an hour of AAC (ADTS), paced in real time, saying its own position
 * every five seconds. It exists to learn whether a locked iPhone keeps playing it, and for how long.
 */
export const AUDIO_TEST_STREAM_ROUTE = "/api/audio/test-stream";

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
