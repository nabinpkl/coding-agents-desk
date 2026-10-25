// Text to speech, as AAC in ADTS framing, with macOS's own `say` and `afconvert`.
//
// Both ship with macOS, so the sidecar speaks with no dependency and no network. A speech model
// would sound better; this answers whether the phone keeps playing at all, which no voice can fix.
//
// Encoded at a constant bitrate, not by `say` itself. `say` writes ADTS directly, but variable
// bitrate (it ignores `--bit-rate`), and silence then costs 11 bytes a frame: a stream of it
// arrived at 240 bytes a second, and Chrome sat at `readyState` 0 on it for as long as it was
// watched, waiting for enough bytes to begin, while the same audio as a whole file played. At a
// constant bitrate a second of silence weighs what a second of speech does, as on a radio stream.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A system binary at a fixed path on every Mac; absolute because the sidecar's PATH is stripped. */
const SAY_BINARY = "/usr/bin/say";
const AFCONVERT_BINARY = "/usr/bin/afconvert";

/** 32 kbit/s: about 4 KB a second whatever is being said, and plenty for one voice. */
const BITS_PER_SECOND = 32_000;

/** Same text, same audio: kept for the process, and dropped on a failure so a retry runs again. */
const spoken = new Map<string, Promise<Uint8Array>>();

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const [diagnostic, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${diagnostic.trim() || "no message"}`);
}

async function runSay(text: string): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-say-"));
  const spokenPcm = join(directory, "speech.aiff");
  const output = join(directory, "speech.aac");
  try {
    await run([SAY_BINARY, "-o", spokenPcm, "--", text]);
    // `-s 0` is the constant-bitrate strategy.
    await run([
      AFCONVERT_BINARY,
      "-f",
      "adts",
      "-d",
      "aac",
      "-b",
      String(BITS_PER_SECOND),
      "-s",
      "0",
      spokenPcm,
      output,
    ]);
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * `text` spoken as ADTS bytes. `say`'s own embedded commands work in it: `[[slnc 500]]` is half a
 * second of silence.
 */
export function speakToAdts(text: string): Promise<Uint8Array> {
  const known = spoken.get(text);
  if (known) return known;
  const running = runSay(text);
  spoken.set(text, running);
  running.catch(() => spoken.delete(text));
  return running;
}
