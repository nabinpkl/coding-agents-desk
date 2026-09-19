import { beforeEach, expect, test } from "bun:test";
import {
  currentLiveQuotas,
  noteRateLimitHeaders,
  parseRateLimitHeaders,
  resetLiveQuotas,
} from "@/usage/claudeLiveQuota";

beforeEach(() => {
  resetLiveQuotas();
});

/** The shape the observer publishes: one object per header, with its own redaction flag. */
function header(name: string, value: string, redacted = false) {
  return { name, value, redacted };
}

/** A real capture, trimmed: observed 2026-09-15 on a `/v1/messages` flow carrying 29 headers. */
function observed() {
  return [
    header("content-type", "text/event-stream"),
    header("anthropic-ratelimit-unified-status", "allowed"),
    header("anthropic-ratelimit-unified-5h-status", "allowed"),
    header("anthropic-ratelimit-unified-5h-utilization", "0.21"),
    header("anthropic-ratelimit-unified-5h-reset", "1789528800"),
    header("anthropic-ratelimit-unified-7d-status", "allowed"),
    header("anthropic-ratelimit-unified-7d-utilization", "0.51"),
    header("anthropic-ratelimit-unified-7d-reset", "1789920000"),
    header("authorization", "[REDACTED]", true),
  ];
}

test("the headers are read in their own units: a fraction, and epoch seconds", async () => {
  // Both settled against the CLI rather than assumed. It clamps utilization to [0,1] and
  // multiplies by 100 for its status line, and it tests resets as `resets_at * 1000 > now`.
  // Read as a percent, a window at 51% would render as 1%.
  expect(parseRateLimitHeaders(observed(), 1_789_500_000_000)).toEqual([
    {
      atMs: 1_789_500_000_000,
      usedPercent: 21,
      windowMinutes: 300,
      resetsAtMs: 1_789_528_800_000,
      planType: null,
      scope: null,
    },
    {
      atMs: 1_789_500_000_000,
      usedPercent: 51,
      windowMinutes: 7 * 24 * 60,
      resetsAtMs: 1_789_920_000_000,
      planType: null,
      scope: null,
    },
  ]);
});

test("a window with no utilization is not a row, and a missing reset is not a dropped row", async () => {
  // "How full" is the number being asked for; "when it clears" is the decoration.
  const samples = parseRateLimitHeaders([
    header("anthropic-ratelimit-unified-5h-utilization", "0.4"),
    header("anthropic-ratelimit-unified-7d-reset", "1789920000"),
  ], 5);

  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ windowMinutes: 300, usedPercent: 40, resetsAtMs: 0 });
});

test("a redacted value is not read as a number", async () => {
  // The proxy redacts by replacing the value with `[REDACTED]` and flagging it. Number("[REDACTED]")
  // is NaN, so this is belt and braces -- but a future redaction that substituted a zero would
  // otherwise render as a window with everything left.
  expect(parseRateLimitHeaders([
    header("anthropic-ratelimit-unified-5h-utilization", "0", true),
  ], 5)).toEqual([]);
});

test("anything that is not a header list is no reading, never a throw", async () => {
  for (const input of [undefined, null, {}, "headers", 7]) {
    expect(parseRateLimitHeaders(input, 5)).toEqual([]);
  }
});

test("a flow carrying no rate-limit headers leaves the last reading standing", async () => {
  // Most flows are not `/v1/messages`. A meter that blanked on every heartbeat going past would
  // spend most of its life empty.
  noteRateLimitHeaders(observed(), 1_000);
  noteRateLimitHeaders([header("content-type", "application/json")], 2_000);

  expect(currentLiveQuotas().map((quota) => quota.usedPercent)).toEqual([21, 51]);
});

test("the newest response wins, and an older one arriving late does not overwrite it", async () => {
  noteRateLimitHeaders(observed(), 2_000);
  noteRateLimitHeaders([
    header("anthropic-ratelimit-unified-5h-utilization", "0.99"),
    header("anthropic-ratelimit-unified-5h-reset", "1789528800"),
  ], 1_000);

  expect(currentLiveQuotas().map((quota) => quota.usedPercent)).toEqual([21, 51]);
});

test("before any response has crossed the proxy there is no reading", async () => {
  expect(currentLiveQuotas()).toEqual([]);
});
