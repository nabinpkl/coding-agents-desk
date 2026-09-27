/* A per-caller budget for the expensive route.
 *
 * Send is the only thing here that costs real work: it reads the annotations, builds a brief, writes
 * a link per annotation, and calls the hub. Everything else is a read or a single-row write. So this
 * exists for one route, and the threat is a client in a loop rather than a person, because a person
 * clicks Send and waits.
 *
 * The hub enforces its own per-caller budget on the writes this produces, and these numbers mirror
 * it on purpose. If the two disagreed, the looser one would let a request through that the tighter
 * one then refused, and the reader would see a hub error for something the annotator had already
 * accepted. Matching them means the loop is stopped here, with a clean Retry-After, before it
 * becomes the hub's problem.
 *
 * This is not DDoS protection and does not pretend to be. Every route here is behind Cloudflare
 * Access, so an unauthenticated caller never reaches this code.
 */

export interface Budget {
  /** How large a burst is allowed before the sustained rate applies. */
  capacity: number;
  /** Sustained refill, per second. */
  refillPerSecond: number;
}

/** Mirrors the hub's write budget, so a refusal happens at the same threshold on both sides. */
export const SEND_BUDGET: Budget = { capacity: 10, refillPerSecond: 0.1 };

/** A caller is over budget. Carries the wait so the response can say when to come back. */
export class OverBudget extends Error {
  readonly retryAfterSeconds: number;

  constructor(key: string, budget: Budget, retryAfterSeconds: number) {
    super(`${key} is over its send budget; retry in ${retryAfterSeconds}s`);
    this.name = "OverBudget";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface State {
  tokens: number;
  last: number;
}

/**
 * A token bucket per caller, in this process's memory.
 *
 * In memory on purpose: it is a guard against a loop, not a quota, and it resets when the server
 * restarts, which is correct for that job. Keyed by the verified identity rather than by anything
 * the request carries, so a caller cannot reset its own budget by asking twice under one name.
 */
export class SendBudget {
  private readonly states = new Map<string, State>();
  private readonly budget: Budget;
  private readonly clock: () => number;

  constructor(budget: Budget = SEND_BUDGET, clock: () => number = () => Date.now()) {
    this.budget = budget;
    this.clock = clock;
  }

  /** Spends one send for a caller, or refuses with the wait attached. */
  spend(key: string): void {
    const now = this.clock();
    const state = this.states.get(key) ?? { tokens: this.budget.capacity, last: now };
    const elapsed = Math.max(0, now - state.last) / 1000;
    state.tokens = Math.min(this.budget.capacity, state.tokens + elapsed * this.budget.refillPerSecond);
    state.last = now;
    if (state.tokens < 1) {
      this.states.set(key, state);
      throw new OverBudget(key, this.budget, Math.ceil((1 - state.tokens) / this.budget.refillPerSecond));
    }
    state.tokens -= 1;
    this.states.set(key, state);
  }

  /** For tests and diagnostics. */
  remaining(key: string): number {
    const state = this.states.get(key);
    return state === undefined ? this.budget.capacity : Math.floor(state.tokens * 100) / 100;
  }
}

/** The budget key for a verified caller: an email or a service token id, never the request body. */
export function budgetKey(identity: { kind: "user"; email: string } | { kind: "service"; clientId: string }): string {
  return identity.kind === "user" ? identity.email : `service:${identity.clientId}`;
}
