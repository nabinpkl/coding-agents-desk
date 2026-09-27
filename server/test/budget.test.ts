/* The send budget: the arithmetic, that one caller's loop cannot spend another's, and that the
 * route really does answer 429 with a wait rather than building a brief per request. */
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { budgetKey, OverBudget, SendBudget, SEND_BUDGET } from "../src/budget.ts";

const small = { capacity: 3, refillPerSecond: 1 };

describe("SendBudget", () => {
  it("allows a burst up to capacity, then refuses with the wait attached", () => {
    let now = 0;
    const budget = new SendBudget(small, () => now);
    for (let i = 0; i < 3; i += 1) budget.spend("owner@example.com");
    try {
      budget.spend("owner@example.com");
      assert.fail("should have refused");
    } catch (error) {
      assert.ok(error instanceof OverBudget);
      assert.equal((error as OverBudget).retryAfterSeconds, 1);
    }
  });

  it("refills with time, so a client that backs off recovers on its own", () => {
    let now = 0;
    const budget = new SendBudget(small, () => now);
    for (let i = 0; i < 3; i += 1) budget.spend("owner@example.com");
    assert.throws(() => budget.spend("owner@example.com"), OverBudget);
    now += 1000;
    assert.doesNotThrow(() => budget.spend("owner@example.com"));
  });

  it("keys per caller, so one in a loop cannot silence another", () => {
    const budget = new SendBudget(small, () => 0);
    for (let i = 0; i < 3; i += 1) budget.spend("noisy@example.com");
    assert.throws(() => budget.spend("noisy@example.com"), OverBudget);
    // A different caller is untouched, which is the point of keying on the verified identity.
    for (let i = 0; i < 3; i += 1) assert.doesNotThrow(() => budget.spend("quiet@example.com"));
  });

  it("mirrors the hub's write budget, so the two layers agree on where a loop is stopped", () => {
    // If these drifted apart, a request the annotator allowed would be refused by the hub and the
    // reader would see a hub error for something already accepted here.
    assert.equal(SEND_BUDGET.capacity, 10);
    assert.equal(SEND_BUDGET.refillPerSecond, 0.1);
  });
});

describe("budgetKey", () => {
  it("uses the verified identity and nothing the request carries", () => {
    assert.equal(budgetKey({ kind: "user", email: "owner@example.com" }), "owner@example.com");
    assert.equal(budgetKey({ kind: "service", clientId: "svc.access" }), "service:svc.access");
  });
});

describe("the send route", () => {
  it("answers 429 with Retry-After once a caller is over budget, and does not reach the hub", async () => {
    const { startHarness } = await import("./harness.ts");
    const h = await startHarness({ sendBudget: new SendBudget({ capacity: 2, refillPerSecond: 0.0001 }) });
    try {
      const post = () => h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [1], to: "opencode:ses_1" }) });
      // The first two are charged and then fail on their own merits (no such annotation), which is
      // fine: the budget is spent by the attempt, which is the point.
      await post();
      await post();
      const third = await post();
      assert.equal(third.status, 429);
      assert.equal(third.headers.get("retry-after"), "10000", "the wait is the budget's own, not invented");
      // And nothing reached the hub, so a loop never becomes the hub's problem.
      assert.equal(h.hub.sent.length, 0);
    } finally {
      await h.close();
    }
  });

  it("still needs the owner's token: the budget is not a way in", async () => {
    const { startHarness } = await import("./harness.ts");
    const h = await startHarness();
    try {
      const res = await h.fetch("/api/v1/send", { method: "POST", as: null, body: JSON.stringify({ ids: [1], to: "opencode:ses_1" }) });
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });
});
