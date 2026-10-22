// A spoken audio channel from the Mac to the panel and Agent Radio, served by the audio process
// (`agent-feed/sidecar/src/audio/audioServer.ts`), which outlives the sidecar's restarts.
//
// One long-lived audio stream rather than a clip per message: a phone starts playback only from a
// tap, and a clip that ends can let iOS close the audio session, after which the next one does not
// start on a locked screen. So the audio process keeps one stream playing, noise between messages.

/**
 * `GET /api/audio/stream?listener=<id>&noise=<level>&color=<color>&voice=<level>`: AAC (ADTS), paced
 * in real time, a bed of noise with agents' messages over it, mixed as the device's `AudioMix` says,
 * for as long as the listener stays.
 *
 * `listener` names the device, so its mix can change without reconnecting and two connections from
 * one device (a phone probes a stream before playing it) count as one listener. Resuming is
 * connecting again.
 */
export const AUDIO_STREAM_ROUTE = "/api/audio/stream";

/** Levels, noise and voice alike, run from 0, silence, to this. */
export const AUDIO_LEVEL_MAX = 10;

/**
 * The noise a device can pick. White is even across every pitch, a hiss. Pink falls off as pitch
 * rises, which the ear hears as even: rain, a radio between stations. Brown falls off faster still:
 * a low rumble, surf.
 */
export const AUDIO_NOISE_COLORS = ["white", "pink", "brown"] as const;

export type AudioNoiseColor = (typeof AUDIO_NOISE_COLORS)[number];

/**
 * How one device hears the channel. Mixed on the Mac rather than on the device, because iOS ignores
 * a page setting an element's volume, and a page's own Web Audio is suspended once the screen locks.
 *
 * - `noise`: the bed's level, 0 to `AUDIO_LEVEL_MAX`.
 * - `color`: the bed's color.
 * - `voice`: the messages' level, 0 to `AUDIO_LEVEL_MAX`. 8 is about as spoken, 10 the loudest that
 *   does not clip.
 */
export type AudioMix = { noise: number; color: AudioNoiseColor; voice: number };

/**
 * `POST /api/audio/mix`: change a listening device's mix, any part of it, heard once what the stream
 * has already sent ahead has played. 404 when that device has no stream open.
 */
export const AUDIO_MIX_ROUTE = "/api/audio/mix";

export type AudioMixRequest = { listener: string } & Partial<AudioMix>;

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

/**
 * `POST /api/speech/read`: read a reply out loud on this Mac's speech process
 * (`agent-feed/speech/speech_server.py`), to whoever listens on its push stream, in line with the
 * sessions' own announcements so the two never talk over each other. The sidecar's route, not the
 * audio process's. The session's own report blocks are left out and the rest is made speakable:
 * code is named rather than read, and a reply past `SPEECH_READ_MAX_CHARS` is cut at a sentence.
 * One reply at a time: reading another stops this one. With nobody listening it is refused, 409
 * `nobody_listening`, and nothing is made; one stopped before it finished answers 409 `stopped`.
 */
export const SPEECH_READ_ROUTE = "/api/speech/read";

/** `POST /api/speech/stop`: stops the reply being read out loud, wherever it is, and answers 204. */
export const SPEECH_STOP_ROUTE = "/api/speech/stop";

export const SPEECH_READ_MAX_CHARS = 4_000;

export type SpeechReadRequest = { text: string };

/** `listeners` is how many pages it went to; `durationMs` how long it plays. */
export type SpeechReadResponse = { listeners: number; durationMs: number };

/**
 * `POST /api/speech/here`: a reply made into speech on this Mac and handed back to the page that
 * asked, to play on its own device rather than to Agent Radio's listeners. Made speakable and cut
 * as `SPEECH_READ_ROUTE` does, outside its line, so it neither waits behind nor stops what is being
 * said there. The body is the speech as it is made: float32 little-endian mono PCM at
 * `SPEECH_SAMPLE_RATE`, ending when the whole message is made. 422 `nothing_to_say` when nothing in
 * the text can be said. Always this Mac's sidecar, whichever machine the reply came from: only this
 * Mac has the voice.
 */
export const SPEECH_HERE_ROUTE = "/api/speech/here";

/** `POST /api/speech/here/stop` <- `{ ref }`: stops making that page's speech, and answers 204. */
export const SPEECH_HERE_STOP_ROUTE = "/api/speech/here/stop";

export const SPEECH_SAMPLE_RATE = 24_000;

/** `ref` is the page's own name for this playback, so it can stop it: letters, digits and dashes. */
export type SpeechHereRequest = { text: string; ref: string };
