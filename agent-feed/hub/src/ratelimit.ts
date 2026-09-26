// Per-principal request budgets.
//
// What this is for, and what it is not. It is not DDoS protection: the hub sits behind Cloudflare
// Access, so an unauthenticated caller never reaches this code, and volumetric traffic is absorbed
// at the edge before it arrives. A limiter in here does nothing about that and is not pretending to.
//
// It is for the two things that actually happen. A client of ours in a loop -- a dead default once
// made two machines publish their whole Bot list seventy-nine times a minute, and nothing noticed,
// because nothing was counting. And a leaked credential, which can post as the owner and hold
// streams open. Both are authenticated, so the only place that can refuse them is here. A
// client-side guard is cheaper and worth having, but it is a request from a caller that may be the
// thing misbehaving.
//
// Keyed on the Access client id rather than on the address a caller claims, because the claimed
// address is chosen by the caller: a bucket keyed on it can be reset by sending as something else.

import { RateLimited } from "@/messages";

export interface Bucket {
  /** How large a burst is allowed before the sustained rate applies. */
  capacity: number;
  /** Sustained refill, per second. */
  refillPerSecond: number;
}

export interface Limits {
  writes: Bucket;
  reads: Bucket;
  /** Concurrent live streams one principal may hold. */
  maxStreams: number;
}

/**
 * Sized from what the system actually does, measured on the hub's own log, with headroom, so the
 * ceiling is above normal and well below a loop.
 *
 * Writes are only meant to happen when a Bot changes, and a change is a handful at once, so ten
 * back to back and six a minute after that. Measured: two a minute, one per machine's timer.
 *
 * Reads are polled. Measured: zero to six a minute with a panel open, so sixty before the sustained
 * rate applies is three orders of magnitude of headroom.
 *
 * The stream cap is the one that needs care, because a machine holds one stream per live session:
 * fifty on the mac at the time of writing. Two hundred is four times that, and the extra room is for
 * a restart, where the old connections can still be closing while the new ones open. A cap at twice
 * the largest machine would sit exactly on that boundary and hand a restarting machine a stream
 * refusal, which is the guard turning on the system it was meant to protect. Two hundred still
 * bounds a leaked token, which is the case that matters.
 */
export const DEFAULT_LIMITS: Limits = {
  writes: { capacity: 10, refillPerSecond: 0.1 },
  reads: { capacity: 60, refillPerSecond: 10 },
  maxStreams: 200,
};

interface BucketState {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly streams = new Map<string, number>();

  constructor(private readonly limits: Limits = DEFAULT_LIMITS, private readonly clock: () => number = () => Date.now()) {}

  /**
   * Spends one token from a principal's bucket, or refuses.
   *
   * A refusal says how long to wait, because a client that is told only "no" retries immediately
   * and turns one loop into two.
   */
  take(key: string, kind: "writes" | "reads", what: string): void {
    const bucket = this.limits[kind];
    const now = this.clock();
    // Keyed by kind as well as caller: a panel reading hard must not spend a machine's publish
    // budget, and one balance for both would mean a busy reader starves the thing reporting.
    const id = `${kind}:${key}`;
    const state = this.buckets.get(id) ?? { tokens: bucket.capacity, last: now };
    const elapsed = Math.max(0, now - state.last) / 1000;
    state.tokens = Math.min(bucket.capacity, state.tokens + elapsed * bucket.refillPerSecond);
    state.last = now;
    if (state.tokens < 1) {
      this.buckets.set(id, state);
      const wait = Math.ceil((1 - state.tokens) / bucket.refillPerSecond);
      throw new RateLimited(`${key} is over its ${kind} budget: ${what}. Retry in ${wait}s.`, wait);
    }
    state.tokens -= 1;
    this.buckets.set(id, state);
  }

  /**
   * Reserves one of a principal's stream slots, answering the function that gives it back.
   *
   * A stream is held open for hours, so the number of them is the resource that runs out, and it is
   * the one a leaked token can take for free.
   */
  holdStream(key: string): () => void {
    const held = this.streams.get(key) ?? 0;
    if (held >= this.limits.maxStreams) {
      throw new RateLimited(`${key} already holds ${held} streams, which is the limit`);
    }
    this.streams.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.streams.get(key) ?? 1) - 1;
      if (left <= 0) this.streams.delete(key);
      else this.streams.set(key, left);
    };
  }

  /** For tests and diagnostics. */
  snapshot(): { buckets: Array<[string, number]>; streams: Array<[string, number]> } {
    return { buckets: [...this.buckets].map(([k, s]) => [k, Math.floor(s.tokens * 100) / 100]), streams: [...this.streams] };
  }
}
