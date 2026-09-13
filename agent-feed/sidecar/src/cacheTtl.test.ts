import { describe, expect, test } from "bun:test";
import { cacheTtlFromUsage } from "@/cacheTtl";

const HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

describe("cacheTtlFromUsage", () => {
  test("reads the hour Claude Code asks for", () => {
    expect(
      cacheTtlFromUsage({
        cache_creation: { ephemeral_1h_input_tokens: 1243, ephemeral_5m_input_tokens: 0 },
      }),
    ).toBe(HOUR);
  });

  test("reads the five minutes the python SDK defaults to", () => {
    expect(
      cacheTtlFromUsage({
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 },
      }),
    ).toBe(FIVE_MINUTES);
  });

  test("takes the longer lifetime when a request writes at both", () => {
    expect(
      cacheTtlFromUsage({
        cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5000 },
      }),
    ).toBe(HOUR);
  });

  test("a request that wrote nothing names no lifetime", () => {
    expect(
      cacheTtlFromUsage({
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
    ).toBeNull();
    expect(cacheTtlFromUsage({ cache_read_input_tokens: 200_000 })).toBeNull();
  });

  test("a provider that reports no breakdown names no lifetime", () => {
    expect(cacheTtlFromUsage(null)).toBeNull();
    expect(cacheTtlFromUsage({ cache_creation: "1h" })).toBeNull();
    expect(cacheTtlFromUsage({ cache_creation: [3600] })).toBeNull();
  });
});
