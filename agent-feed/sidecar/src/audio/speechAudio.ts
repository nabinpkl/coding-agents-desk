// Text to speech with macOS's own `say`, and samples to AAC in ADTS framing with `afconvert`.
//
// Both ship with macOS, so the sidecar speaks with no dependency and no network. Speaking and
// encoding are two steps so noise can be mixed into the samples between them (`pcmAudio.ts`).
//
// Encoded at a constant bitrate, not by `say` itself. `say` writes ADTS directly, but variable
// bitrate (it ignores `--bit-rate`), and silence then costs 11 bytes a frame: a stream of it
// arrived at 240 bytes a second, and Chrome sat at `readyState` 0 on it for as long as it was
// watched, waiting for enough bytes to begin, while the same audio as a whole file played. At a
// constant bitrate a second of silence weighs what a second of speech does, as on a radio stream.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitAdtsFrames, type AdtsFrame } from "@/audio/adtsFrames";
import { readWav, SAMPLE_RATE, writeWav } from "@/audio/pcmAudio";

/** System binaries at a fixed path on every Mac; absolute because the sidecar's PATH is stripped. */
const SAY_BINARY = "/usr/bin/say";
const AFCONVERT_BINARY = "/usr/bin/afconvert";

/** 32 kbit/s: about 4 KB a second whatever is being said, and plenty for one voice. */
const BITS_PER_SECOND = 32_000;

/**
 * Frames dropped from each end of an encoding. An encoder's first frames ramp up from nothing and
 * its last one flushes, so pieces encoded apart dipped where they met: under steady noise, a gap
 * of quiet at every join. Speech starts and ends in its own silence, so nothing said is lost.
 */
const TRIM_START_FRAMES = 3;
const TRIM_END_FRAMES = 2;

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const [diagnostic, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${diagnostic.trim() || "no message"}`);
}

async function inScratchDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-say-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** `text` spoken as samples at `SAMPLE_RATE`. */
export function speakToSamples(text: string): Promise<Int16Array> {
  return inScratchDirectory(async (directory) => {
    const output = join(directory, "speech.wav");
    await run([SAY_BINARY, "--file-format=WAVE", `--data-format=LEI16@${SAMPLE_RATE}`, "-o", output, "--", text]);
    return readWav(new Uint8Array(await readFile(output)));
  });
}

/** `samples` as ADTS frames, with each end trimmed so pieces encoded apart join cleanly. */
export function encodeToAdts(samples: Int16Array): Promise<AdtsFrame[]> {
  return inScratchDirectory(async (directory) => {
    const input = join(directory, "samples.wav");
    const output = join(directory, "samples.aac");
    await writeFile(input, writeWav(samples));
    // `-s 0` is the constant-bitrate strategy.
    const encoding = ["-f", "adts", "-d", "aac", "-b", String(BITS_PER_SECOND), "-s", "0"];
    await run([AFCONVERT_BINARY, ...encoding, input, output]);
    const frames = splitAdtsFrames(new Uint8Array(await readFile(output)));
    return frames.slice(TRIM_START_FRAMES, Math.max(TRIM_START_FRAMES, frames.length - TRIM_END_FRAMES));
  });
}
