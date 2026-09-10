// Which running encoder a request belongs to, and what to do about the one already there.
//
// All string work over the argv a capture is started with, and deliberately no state: the pool
// asks these questions of what it holds, and a wrong answer here would be a second capture of
// one target rather than a wrong number in a log.

/**
 * What a running child cannot be re-tasked to do.
 *
 * Bitrate is excluded on purpose: the control channel adjusts it live, and folding it in here would
 * retire the encoder every time the receiver's bandwidth estimate moved.
 */
export function captureIdentity(args: readonly string[]): string {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--bitrate") {
      index += 1;
      continue;
    }
    kept.push(args[index]!);
  }
  return kept.join(" ");
}

/**
 * The target plus the pixels asked of it: `display:UUID|whole`, or `display:UUID|x,y,w,h`.
 *
 * The crop is in, because it decides WHICH pixels: the viewer's coarse whole-display stream and
 * its sharp cropped one are different content and must both exist, or a pan past the sharp region
 * shows the viewport's bare edge. A re-aim lands on its own key too, so it does not kill the
 * encoder the viewer is still painting from; that one lingers for its last subscriber and dies on
 * its own, which is also what keeps a new capture from starting on top of an old one's teardown.
 *
 * Width, height and fps are out, because they decide only HOW MANY pixels of the same content, and
 * a second capture for that starves the first. Measured 2026-09-06 on the agent session's 8K with
 * them in the key: 990 wide beside 5776 wide on one display for 557s, 2310 beside 2888 for 197s,
 * and fourteen captures that produced two frames or fewer.
 */
export function encoderStreamKey(captureKey: string, args: readonly string[]): string {
  const index = args.indexOf("--source-rect");
  return `${captureKey}|${index >= 0 ? args[index + 1] : "whole"}`;
}

export type EncoderDisposition = "spawn" | "reuse" | "join" | "retask";

/**
 * What to do about the encoder already running on a capture stream when a new offer arrives for
 * it. Staleness is not here: a rebuilt helper retires every stream of the target, above.
 *
 * This is the only place a second capture of one stream could be created, and it never answers
 * that.
 */
export function encoderDisposition(
  running: { identity: string; subscribers: number } | undefined,
  wanted: { identity: string },
): EncoderDisposition {
  if (!running) return "spawn";
  if (running.identity === wanted.identity) return "reuse";
  // Nobody is watching, so serving the geometry this offer asks for costs a respawn and nothing
  // else: the lone viewer changing resolution, or coming back from a reload at another size.
  if (running.subscribers === 0) return "retask";
  // Somebody is. Two captures of one stream starve each other, and evicting the watcher would have
  // it reconnect at its own geometry and evict this one straight back, so the running geometry
  // wins and the joining viewer's element scales the picture.
  return "join";
}

/** A short name for a geometry, for the diagnostics log; the identity is too long to read there. */
export function geometryTag(args: readonly string[]): string {
  const after = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const rect = after("--source-rect") ?? "whole";
  const size = `${after("--width") ?? "auto"}x${after("--height") ?? "auto"}`;
  return `${rect}@${size}`;
}
