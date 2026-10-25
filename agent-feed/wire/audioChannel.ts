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
 * player has dropped it, and so has one whose page noticed it was interrupted. While the push
 * experiment is checked in (`agent-feed/sidecar/src/audio/speechPushExperiment.ts`) it counts the
 * pages listening to the Mac's speech process instead, which is where `AUDIO_SPEAK_ROUTE` then
 * sends a message; such a page counts while its stream is open, paused or not.
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
 * `POST /api/speech/say`: something short a session tells whoever listens on Agent Radio, said as
 * that session: named the way its announcements are, in the voice its Bot gave it, after the "done"
 * tone, in line with the announcements and behind any that needs the person. `session` is
 * `<source>:<session id>`; `tools/agent-radio-say.sh` sends the calling session's own. Answers once
 * it is said. At most `AUDIO_SPEAK_MAX_CHARS`, refused past that (413 `message_too_long`) rather than
 * cut. 409 `nobody_listening` with no page listening, and nothing is made; 409 `replaced` when the
 * session's next message took its place before it went, `stopped` when it was cancelled part way;
 * 404 `unknown_session`; 422 `nothing_to_say`.
 */
export const SPEECH_SAY_ROUTE = "/api/speech/say";

export type SpeechSayRequest = { session: string; text: string };

/** Who it was said as, and in which voice: null for the voice in use, which a session outside a Bot speaks in. */
export type SpeechSayResponse = SpeechReadResponse & { speaker: string; voice: string | null };

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

/**
 * `GET /api/speech/tuning` -> `SpeechTuningState`; `POST` <- some of `SpeechTuning` -> the same.
 * How the Mac's speech process treats speech before it is sent, so it is heard loud and clear over
 * the page's noise: each voice brought to one level, the tone shaped, quiet syllables lifted by a
 * compressor and peaks held under a limiter. The speech process keeps the settings, on disk, and
 * owns their ranges; each frame reads them as they are, so a change is heard in the message already
 * playing. A number past its range is held to it; anything else it does not know is refused, 400
 * `invalid_tuning`. 502 `speech_unreachable` when the speech process is not answering.
 */
export const SPEECH_TUNING_ROUTE = "/api/speech/tuning";

export type SpeechTuning = {
  /** Whether speech is processed at all. */
  on: boolean;
  /** Each voice brought to one speech level first, from its measured level. */
  evenLevels: boolean;
  /** The gain put back after the compressor. */
  loudnessDb: number;
  /** Where the compressor starts turning speech down. */
  thresholdDb: number;
  /** How hard it turns speech down past the threshold. */
  ratio: number;
  /** How fast it lets go: fast lifts each quiet syllable, slow acts on whole phrases. */
  releaseMs: number;
  /** Below this the boom is cut. */
  boomCutHz: number;
  /** The dip around 300 Hz, where a voice turns muddy. */
  mudDb: number;
  /** The lift around 3 kHz, where consonants are. */
  presenceDb: number;
};

export type SpeechTuningNumber = Exclude<keyof SpeechTuning, "on" | "evenLevels">;

export type SpeechTuningState = {
  tuning: SpeechTuning;
  ranges: Record<SpeechTuningNumber, { min: number; max: number; step: number }>;
};
