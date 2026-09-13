// How long the prompt cache behind a session's context stays warm, read off the usage record.
//
// Why this is worth publishing at all: a context that is still cached costs 0.1x base input to
// re-read, and one that has expired costs 2.0x to rewrite -- a 20x step, paid in full on the next
// message. Measured on this project's transcripts, a 500k session that sleeps through its TTL pays
// $5.00 for the message that wakes it against $0.47 for the same message sent while warm. Nothing
// on the surface says which side of that line a session is on, and the reader cannot work it out:
// the file looks identical either way.
//
// Read from `usage.cache_creation` rather than mapped from the entrypoint, because that field is
// what the request actually wrote. The two agree -- 107,222 requests here from `claude-desktop`,
// `cli` and `sdk-cli` are 1h without exception, and all 2,652 from `sdk-py` are 5m without
// exception, so it is the client and not the plan that picks -- but an entrypoint table would be a
// second place to keep that fact current, and this one cannot drift from the request it describes.
//
// The hour is real and the cliff is sharp. Idle gap before a request, against how much of its
// context came back as a cache read, over the 25 largest transcripts here:
//
//     <5m      34,543 requests   median 99.7%   100% kept more than half
//     30-60m       44 requests   median 98.0%    57% kept more than half
//     60-70m        5 requests   median 31.8%     0% kept more than half
//     >120m        47 requests   median 15.3%     0% kept more than half
//
// Not one request out of the 69 past the hour mark kept its cache. So a deadline of
// `updatedAt + ttl` is a real deadline rather than a hint, and the panel can count down to it.

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * The cache lifetime this request bought, or null when it bought none.
 *
 * Null on every request that wrote nothing to the cache, which is a pure hit and says nothing
 * about the TTL, and on every provider that does not report Anthropic's breakdown at all. Both are
 * answered by the session-level merge carrying the last known value forward, the same way it
 * carries the window -- a report that names no lifetime is not a report that the lifetime changed.
 *
 * A request that writes at both lifetimes takes the longer one. Mixed breakpoints mean different
 * segments of one prefix expire at different times, and the cheap half expiring first is not what
 * the reader is being warned about: what costs money is the whole context going cold.
 */
export function cacheTtlFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const creation = (usage as Record<string, unknown>).cache_creation;
  if (!creation || typeof creation !== "object" || Array.isArray(creation)) return null;
  const fields = creation as Record<string, unknown>;
  const hour = fields.ephemeral_1h_input_tokens;
  if (typeof hour === "number" && hour > 0) return ONE_HOUR_MS;
  const minutes = fields.ephemeral_5m_input_tokens;
  if (typeof minutes === "number" && minutes > 0) return FIVE_MINUTES_MS;
  return null;
}
