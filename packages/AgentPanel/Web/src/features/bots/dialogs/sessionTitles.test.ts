import { describe, expect, it } from "vitest";
import { forkBaseTitle, nextForkTitle } from "@/features/bots/dialogs/sessionTitles";

describe("naming a fork", () => {
  it("numbers the first fork of a session", () => {
    expect(nextForkTitle("Windows canvas", [])).toBe("Windows canvas (fork 1)");
  });

  it("counts from the forks that already exist rather than from zero", () => {
    // The point of the whole module: without this, every fork of one session is "(fork 1)" and the
    // rows are as indistinguishable as they were with no suffix at all.
    expect(nextForkTitle("Windows canvas", [
      "Windows canvas",
      "Windows canvas (fork 1)",
      "Windows canvas (fork 2)",
      "Something else (fork 9)",
    ])).toBe("Windows canvas (fork 3)");
  });

  it("takes the highest number rather than the count, so a deleted fork does not collide", () => {
    expect(nextForkTitle("Thing", ["Thing (fork 4)"])).toBe("Thing (fork 5)");
  });

  it("forks a fork into the next number, not into a second suffix", () => {
    expect(nextForkTitle("Thing (fork 2)", ["Thing (fork 2)"])).toBe("Thing (fork 3)");
  });

  it("ignores a suffix belonging to a different session", () => {
    expect(nextForkTitle("Thing", ["Other thing (fork 7)", "Thing extra (fork 3)"]))
      .toBe("Thing (fork 1)");
  });

  it("reads a base off a title that carries no suffix", () => {
    expect(forkBaseTitle("Plain title")).toBe("Plain title");
    expect(forkBaseTitle("Plain title (fork 12)")).toBe("Plain title");
    // Not a suffix this writes: the number is what makes it one.
    expect(forkBaseTitle("Plain title (fork)")).toBe("Plain title (fork)");
  });

  it("keeps a title that is nothing but a suffix, rather than naming a fork after nothing", () => {
    expect(nextForkTitle("(fork 2)", [])).toBe("(fork 2) (fork 1)");
  });
});
