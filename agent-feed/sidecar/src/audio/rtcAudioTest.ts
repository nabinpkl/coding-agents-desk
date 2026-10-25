// Throwaway experiment, not part of the channel: the channel's noise and messages as a WebRTC audio
// track, to learn whether a phone keeps playing WebRTC audio on a locked screen, and how soon a
// message is heard. `POST /api/audio/rtc-test` takes the page's offer (`public/rtc-test.html`).
//
// G.711 mu-law at 8 kHz, because every browser takes it and it needs no encoder: telephone quality,
// which is enough to hear whether it plays. A message is mixed in at the very next packet, so there
// is no splice margin: what is left of the delay is the network and the browser's jitter buffer.

import { networkInterfaces } from "node:os";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from "werift";
import { audioChannel } from "@/audio/audioChannel";
import { noiseBed } from "@/audio/noiseBed";
import { SAMPLE_RATE, voiceGain } from "@/audio/pcmAudio";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

export const RTC_TEST_ROUTE = "/api/audio/rtc-test";

const OUT_RATE = 8_000;
const PACKET_SAMPLES = 160; // 20 ms
const PACKET_MS = (PACKET_SAMPLES * 1000) / OUT_RATE;
// NACK on audio: the phone names the packets it missed and the sender sends them again from its
// history, so a burst of loss is repaired rather than heard, given a jitter buffer long enough to
// wait for the repair (the page sets one). Browsers do not offer it for audio themselves; the page
// adds it to its offer.
const PCMU = new RTCRtpCodecParameters({
  mimeType: "audio/PCMU",
  clockRate: OUT_RATE,
  channels: 1,
  rtcpFeedback: [{ type: "nack" }],
});
/** Ten seconds of packets kept for resending, far longer than any burst seen (0.4 s). */
const RTP_HISTORY_PACKETS = 500;
/** Each live peer's resend counters, by label, for the stats route. */
const senders = new Map<string, () => unknown>();
const VOICE_LEVEL = 8;

/** werift skips utun devices; the tailnet address is the one path a phone on any network has. */
function tailnetIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const octets = address.address.split(".").map(Number);
      if (address.family === "IPv4" && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) {
        return address.address;
      }
    }
  }
  return null;
}

/** G.711 mu-law, the encoder every telephone has. */
function muLaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = Math.min(32_635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

async function answer(request: Request, noiseLevel: number): Promise<Response> {
  const offer = (await request.json()) as { type?: string; sdp?: string };
  if (offer.type !== "offer" || !offer.sdp) return jsonResponse({ code: "bad-offer" }, 400);
  const tailnet = tailnetIPv4();
  const peer = new RTCPeerConnection({
    codecs: { audio: [PCMU] },
    iceAdditionalHostAddresses: tailnet ? [tailnet] : undefined,
    rtpHistorySize: RTP_HISTORY_PACKETS,
  });
  const track = new MediaStreamTrack({ kind: "audio" });
  const transceiver = peer.addTransceiver(track, { direction: "sendonly" });
  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  await peer.setLocalDescription(await peer.createAnswer());

  const label = `rtc-test ${crypto.randomUUID().slice(0, 8)}`;
  const bed = await noiseBed("pink", noiseLevel);
  const gain = voiceGain(VOICE_LEVEL);
  // Messages waiting or playing, at the channel's rate, and how far into the first one playback is.
  const speech: Int16Array[] = [];
  let speechAt = 0;
  const unlisten = audioChannel.listen(label, { noise: noiseLevel, color: "pink", voice: VOICE_LEVEL }, (s) =>
    speech.push(s),
  );
  // Position in the channel's own samples (22.05 kHz), as a fraction, stepped 22050/8000 per output sample.
  let sourceAt = 0;
  const step = SAMPLE_RATE / OUT_RATE;
  const sourceSample = (index: number) => {
    let value = bed.samples[index % bed.samples.length] ?? 0;
    const playing = speech[0];
    if (playing) {
      value += (playing[speechAt] ?? 0) * gain;
    }
    return value;
  };
  const nextPacket = (): Buffer => {
    const out = Buffer.alloc(PACKET_SAMPLES);
    for (let n = 0; n < PACKET_SAMPLES; n += 1) {
      // Average the source samples this output sample covers: a crude low-pass before decimating.
      const from = Math.floor(sourceAt);
      sourceAt += step;
      const to = Math.floor(sourceAt);
      let sum = 0;
      for (let i = from; i < to; i += 1) {
        sum += sourceSample(i);
        if (speech[0]) {
          speechAt += 1;
          if (speechAt >= speech[0].length) {
            speech.shift();
            speechAt = 0;
          }
        }
      }
      out[n] = muLaw(Math.round(sum / Math.max(1, to - from)));
    }
    return out;
  };

  const random = crypto.getRandomValues(new Uint32Array(2));
  let sequence = random[0]! & 0xffff;
  let timestamp = random[1]!;
  let sent = 0;
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  senders.set(label, () => transceiver.sender.rtpHistoryRepairStats);
  const stop = (why: string) => {
    senders.delete(label);
    if (timer) clearInterval(timer);
    timer = null;
    unlisten();
    void peer.close();
    console.log(`[audio] ${label}: ${why} after ${sent} packets`);
  };
  peer.connectionStateChange.subscribe((state) => {
    console.log(`[audio] ${label}: ${state}`);
    if (state === "connected" && !timer) {
      startedAt = performance.now();
      // A poll on the clock, justified: a packet is due because time passed, and nothing else says so.
      timer = setInterval(() => {
        const due = Math.floor((performance.now() - startedAt) / PACKET_MS);
        while (sent <= due) {
          const header = new RtpHeader({ sequenceNumber: sequence, timestamp, payloadType: 0, ssrc: 0 });
          track.writeRtp(new RtpPacket(header, nextPacket()));
          sequence = (sequence + 1) & 0xffff;
          timestamp = (timestamp + PACKET_SAMPLES) >>> 0;
          sent += 1;
        }
      }, 5);
    }
    if (state === "failed" || state === "closed") stop(state);
  });
  return jsonResponse({ type: "answer", sdp: peer.localDescription!.sdp });
}

/** Each live peer's resend counters, for reading on the Mac. The pages' own reports go to `/api/audio/test-reports`. */
const RTC_STATS_ROUTE = "/api/audio/rtc-test/stats";

/**
 * `/api/audio/kitten-<route>`: dictation, the forwarded mic and Whisper, which go to the dictation
 * experiment, scratchpad `kitten_push.py` on 127.0.0.1:7691, started by hand when that is tried. The
 * speech process's own routes are `speech-*` (`speechPushExperiment.ts`).
 */
const KITTEN_PREFIX = "/api/audio/kitten-";
const DICTATION_EXPERIMENT = "http://127.0.0.1:7691/";

async function forwardToDictation(request: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice(KITTEN_PREFIX.length);
  let answer: Response;
  try {
    answer = await fetch(DICTATION_EXPERIMENT + route + url.search, {
      method: request.method,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      signal: request.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return errorResponse("speech_unreachable", `${DICTATION_EXPERIMENT} did not answer: ${reason}`, 502);
  }
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}

export function createRtcTestRoutes(): RouteHandler {
  return (request, url) => {
    if (url.pathname.startsWith(KITTEN_PREFIX)) return forwardToDictation(request, url);
    if (url.pathname === RTC_STATS_ROUTE && request.method === "GET")
      return jsonResponse({ senders: [...senders].map(([label, stats]) => ({ label, ...(stats() as object) })) });
    if (url.pathname !== RTC_TEST_ROUTE || request.method !== "POST") return undefined;
    // `?noise=0` for a probe that should hear only speech.
    const noise = Number(url.searchParams.get("noise") ?? 3);
    return answer(request, Number.isFinite(noise) ? Math.max(0, Math.min(10, Math.round(noise))) : 3);
  };
}
