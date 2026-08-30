import type { WebrtcPointerInput } from "@agentdesk/agent-feed-wire";

const MAX_MESSAGE_BYTES = 256;
const MAX_DELTA = 10_000;

const PHASE_COMMAND = {
  began: "b",
  changed: "c",
  ended: "e",
  momentumBegan: "mb",
  momentumChanged: "mc",
  momentumEnded: "me",
} as const;

function boundedDelta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DELTA;
}

/** Validate one remote data-channel message and translate it to the native helper's stdin line. */
export function encoderPointerCommand(data: string | Buffer): string | null {
  if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return null;
  let input: WebrtcPointerInput;
  try {
    input = JSON.parse(data.toString()) as WebrtcPointerInput;
  } catch {
    return null;
  }
  if (!input || typeof input !== "object" || typeof input.t !== "string") return null;
  switch (input.t) {
    case "move":
      return boundedDelta(input.dx) && boundedDelta(input.dy)
        ? `M ${input.dx} ${input.dy}\n`
        : null;
    case "click":
      if (input.button === "left") return "C L\n";
      if (input.button === "right") return "C R\n";
      return null;
    case "scroll": {
      if (!boundedDelta(input.dx) || !boundedDelta(input.dy)) return null;
      const phase = PHASE_COMMAND[input.phase];
      return phase ? `S ${input.dx} ${input.dy} ${phase}\n` : null;
    }
    default:
      return null;
  }
}
