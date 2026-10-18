/**
 * @vitest-environment node
 *
 * When a whole file's update waits for the tree it lands in to typecheck, and which files a new
 * error holds. Several agents edit this tree at once, so the answer is per file: one agent's broken
 * edit must hold the code it could break and nothing else.
 */
import { describe, expect, it, vi } from "vitest";
import { createTypeHolds, decideTypeHolds, type TypeCheckReport } from "@/app/dev-server/typeHolds";

const HOOK = "/web/src/features/profile/useStaleSessions.ts";
const APP = "/web/src/app/AgentPanelApp.tsx";
const OTHER = "/web/src/features/arena/ArenaSurface.tsx";

/** `AgentPanelApp.tsx` imports the hook; nothing imports the app or the arena. */
const dependents = (file: string) => new Set(file === HOOK ? [APP] : []);

describe("which waiting files a new error holds", () => {
  it("holds a file whose importer broke, and sends one the error cannot reach", () => {
    const { held, released } = decideTypeHolds(
      [HOOK, OTHER],
      [{ file: APP, reason: "AgentPanelApp.tsx:105: wrong" }],
      dependents,
    );
    expect([...held]).toEqual([[HOOK, "AgentPanelApp.tsx:105: wrong"]]);
    expect(released).toEqual([OTHER]);
  });

  it("holds a file with the error in it", () => {
    const { held } = decideTypeHolds([OTHER], [{ file: OTHER, reason: "ArenaSurface.tsx:3: wrong" }], dependents);
    expect([...held.keys()]).toEqual([OTHER]);
  });
});

describe("the type hold", () => {
  function holds(reports: TypeCheckReport[]) {
    const sent: string[][] = [];
    const published: Map<string, string>[] = [];
    const accepted = vi.fn();
    const check = vi.fn(async () => {
      const next = reports.shift()!;
      return "failed" in next ? next : { ...next, accept: accepted };
    });
    const hold = createTypeHolds(
      {
        check,
        dependents,
        send: (files) => sent.push(files),
        publish: (held) => published.push(held),
        log: () => {},
      },
      0,
    );
    return { hold, sent, published, accepted, check };
  }

  const settle = () => new Promise((done) => setTimeout(done, 20));

  it("sends a held file once the save that fixes its importer lands, with that save", async () => {
    const { hold, sent, published, accepted } = holds([
      { fresh: [{ file: APP, reason: "AgentPanelApp.tsx:105: wrong" }], accept: () => {} },
      { fresh: [], accept: () => {} },
    ]);
    hold.wait(HOOK);
    await settle();
    expect(sent).toEqual([]);
    expect([...published.at(-1)!.keys()]).toEqual([HOOK]);
    expect(accepted).not.toHaveBeenCalled();

    hold.wait(APP);
    await settle();
    expect(sent).toEqual([[HOOK, APP]]);
    expect(published.at(-1)!.size).toBe(0);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("sends everything when the check cannot run, rather than freezing the page", async () => {
    const { hold, sent } = holds([{ failed: "no TypeScript installed beside tsconfig.json" }]);
    hold.wait(HOOK);
    await settle();
    expect(sent).toEqual([[HOOK]]);
  });

  it("judges a burst of saves with one check", async () => {
    const { hold, check } = holds([{ fresh: [], accept: () => {} }]);
    hold.wait(HOOK);
    hold.wait(OTHER);
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
