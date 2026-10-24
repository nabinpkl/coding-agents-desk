import { describe, expect, test } from "bun:test";
import { audioPort } from "@/audio/audioConfig";

describe("the audio process's port", () => {
  test("is the sidecar's plus one, so each host's pair stays apart", () => {
    expect(audioPort({})).toBe(7683);
    expect(audioPort({ AGENT_FEED_PORT: "7782" })).toBe(7783);
  });

  test("can be named outright, and a value that is not a port is ignored rather than used", () => {
    expect(audioPort({ AGENT_FEED_AUDIO_PORT: "9100", AGENT_FEED_PORT: "7782" })).toBe(9100);
    expect(audioPort({ AGENT_FEED_AUDIO_PORT: "nope", AGENT_FEED_PORT: "70000" })).toBe(7683);
  });
});
