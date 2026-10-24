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
