import { describe, expect, test } from "bun:test";
import { lineText } from "@/audio/audioTestStream";

describe("the hour-long test's lines", () => {
  test("each says the stream position it plays at, in as few words as a listener needs", () => {
    expect(lineText(0)).toBe("Hour long audio test. A line every five seconds.");
    expect(lineText(1)).toBe("5 seconds");
    expect(lineText(12)).toBe("1 minute");
    expect(lineText(13)).toBe("1 minute 5");
    expect(lineText(151)).toBe("12 minutes 35");
    expect(lineText(719)).toBe("59 minutes 55");
  });
});
