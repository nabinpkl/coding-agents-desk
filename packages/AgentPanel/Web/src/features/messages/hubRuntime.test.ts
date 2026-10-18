import { describe, expect, test } from "vitest";
import type { DirectoryEntry, MessageAddress, SessionAddress } from "@agentdesk/agent-feed-wire";
import { BOTS_SECTION, recipientGroups, runtimeOf, runtimesOf } from "@/features/messages/hubRuntime";

/** A Bot entry: a label with no session of its own. */
function bot(
  name: string,
  related: MessageAddress[] = [],
  id = name.toLowerCase().replace(/\s+/g, "-"),
): DirectoryEntry {
  return {
    address: `bot:${id}`,
    session: null,
    name,
    machine: "mac",
    reachability: "reachable",
    lastSeenAt: null,
    related,
    cwd: "/work",
  };
}

/**
 * A session entry, as the hub serves it: the address that reaches it, and the session it is.
 *
 * A Bot curating one session gives that session the Bot's own address, so `session` is the only
 * place the run is named, which is why a client holding a session id matches on it.
 */
function session(over: {
  id: string;
  name: string;
  address: MessageAddress;
  bot: MessageAddress;
  cwd?: string;
  machine?: string;
}): DirectoryEntry {
  return {
    address: over.address,
    session: over.id as SessionAddress,
    name: over.name,
    machine: over.machine ?? "mac",
    reachability: "reachable",
    lastSeenAt: null,
    related: [over.bot],
    cwd: over.cwd ?? "/Users/n/desk",
  };
}

describe("runtimeOf", () => {
  test("reads a session's runtime from the session it is", () => {
    expect(runtimeOf(session({ id: "claude:44444444", name: "a", address: "bot:a", bot: "bot:a" }))).toBe("claude");
    expect(runtimeOf(session({ id: "opencode:ses_1", name: "b", address: "bot:b", bot: "bot:b" }))).toBe("opencode");
  });

  test("a Bot and the owner are not sessions, so they name no runtime", () => {
    expect(runtimeOf(bot("Site fixer"))).toBeNull();
    expect(runtimeOf({ ...bot("owner"), address: "human" })).toBeNull();
  });
});

describe("runtimesOf", () => {
  test("a session is its own runtime", () => {
    expect(runtimesOf([session({ id: "opencode:ses_1", name: "a", address: "bot:a", bot: "bot:a" })])).toEqual([
      "opencode",
    ]);
  });

  test("a Bot holding both runtimes is both, because the answer is genuinely both", () => {
    const members = [
      session({ id: "opencode:ses_1", name: "a", address: "bot:x/opencode:ses_1", bot: "bot:x" }),
      session({ id: "claude:a", name: "b", address: "bot:x/claude:a", bot: "bot:x" }),
    ];
    expect(runtimesOf(members)).toEqual(["claude", "opencode"]);
  });

  test("a Bot with no members claims no runtime rather than guessing from its name", () => {
    expect(runtimesOf([])).toEqual([]);
  });
});

describe("recipientGroups", () => {
  const human = { ...bot("owner"), address: "human" as const };
  const fixer = bot("Site fixer", ["bot:fixer/one", "bot:fixer/two"], "fixer");
  const one = session({ id: "opencode:one", name: "Fix header", address: "bot:fixer/one", bot: "bot:fixer" });
  const two = session({ id: "opencode:two", name: "Fix footer", address: "bot:fixer/two", bot: "bot:fixer" });
  const solo = bot("Solo", ["bot:solo"]);
  const soloSession = session({ id: "claude:solo", name: "Only one", address: "bot:solo", bot: "bot:solo" });

  test("one section per Bot, holding the sessions it curates", () => {
    const groups = recipientGroups([human, fixer, one, two]);
    expect(groups.map((group) => group.label)).toEqual(["All bots · Site fixer"]);
    expect(groups[0]!.entries.map((entry) => entry.name)).toEqual(["Fix header", "Fix footer"]);
  });

  test("each row carries the address that reaches it, which the hub supplied", () => {
    // Nothing here assembles an address. A multi-session Bot hands out the qualified form and a
    // single-session Bot hands out its own, so a Bot with several sessions cannot be resolved to a
    // session the reader did not choose.
    const groups = recipientGroups([human, fixer, one, two, solo, soloSession]);
    expect(groups[0]!.entries.map((entry) => entry.address)).toEqual(["bot:fixer/one", "bot:fixer/two"]);
    expect(groups[1]!.entries.map((entry) => entry.address)).toEqual(["bot:solo"]);
  });

  test("a session in no Bot is not in the directory, so the picker cannot offer it", () => {
    // The hub does not list one, and the picker does not invent a section for it. This is the visible
    // half of curation: what the owner has not put in a Bot is not something the panel can deliver to.
    const groups = recipientGroups([human, fixer, one, two]);
    const names = groups.flatMap((group) => group.entries.map((entry) => entry.name));
    expect(names).not.toContain("Loose");
  });

  test("a Bot whose members the hub did not list gets no empty heading", () => {
    expect(recipientGroups([human, bot("Empty")])).toEqual([]);
  });

  test("two sessions with the same name in one Bot get the id tail, and unique ones do not", () => {
    const groups = recipientGroups([
      human,
      fixer,
      session({ id: "opencode:aaaaaa111", name: "Same", address: "bot:fixer/aaaaaa111", bot: "bot:fixer" }),
      session({ id: "opencode:bbbbbb222", name: "Same", address: "bot:fixer/bbbbbb222", bot: "bot:fixer" }),
      session({ id: "opencode:cccccc333", name: "Unique", address: "bot:fixer/cccccc333", bot: "bot:fixer" }),
    ]);
    const names = groups[0]!.entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("Same · aaa111");
    expect(names).toContain("Same · bbb222");
    expect(names).toContain("Unique");
  });

  test("every heading names the one section there is", () => {
    const groups = recipientGroups([human, fixer, one, two]);
    expect(new Set(groups.map((group) => group.label.split(" · ")[0]))).toEqual(new Set([BOTS_SECTION]));
  });
});
