import { describe, expect, it } from "vitest";
import {
  indexFor,
  mergeSidecars,
  parseDeclaredPeers,
  parseDescriptor,
  SIDECAR_STALE_MS,
  type LiveSidecar,
} from "./sidecarBoard";

const NOW = 1_700_000_000_000;

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { user: "agent", label: "Agent", host: "127.0.0.1", port: 7682, heartbeat: NOW, ...overrides };
}

describe("parseDescriptor", () => {
  it("reads a live descriptor", () => {
    expect(parseDescriptor(descriptor(), NOW)).toEqual({
      id: "agent", label: "Agent", host: "127.0.0.1", port: 7682,
    });
  });

  it("defaults a descriptor with no host to loopback", () => {
    // A sidecar from before the field existed writes none, and every board peer is on this machine
    // by definition, so loopback is the right reading rather than a reason to drop the session.
    expect(parseDescriptor(descriptor({ host: undefined }), NOW)?.host).toBe("127.0.0.1");
  });

  it("drops a descriptor whose heartbeat has stopped", () => {
    expect(parseDescriptor(descriptor({ heartbeat: NOW - SIDECAR_STALE_MS - 1 }), NOW)).toBeNull();
  });

  it("refuses a user that would reshape the proxy path", () => {
    for (const user of ["../etc", "a/b", "", "with space"]) {
      expect(parseDescriptor(descriptor({ user }), NOW)).toBeNull();
    }
  });

  it("refuses a descriptor with no usable port", () => {
    expect(parseDescriptor(descriptor({ port: "7682" }), NOW)).toBeNull();
    expect(parseDescriptor(descriptor({ port: 7682.5 }), NOW)).toBeNull();
  });
});

describe("parseDeclaredPeers", () => {
  it("reads id=host:port entries", () => {
    expect(parseDeclaredPeers("oracle=oracle.example.ts.net:7682")).toEqual([
      { id: "oracle", label: "oracle", host: "oracle.example.ts.net", port: 7682 },
    ]);
  });

  it("reads several, and tolerates spacing", () => {
    expect(parseDeclaredPeers(" oracle=10.0.0.1:7682 , box=box:80 ").map((peer) => peer.id))
      .toEqual(["oracle", "box"]);
  });

  it("is empty when unset, so an origin with no peers behaves as it always did", () => {
    expect(parseDeclaredPeers(undefined)).toEqual([]);
    expect(parseDeclaredPeers("")).toEqual([]);
  });

  it("drops a malformed entry rather than failing the whole list", () => {
    // A typo in one peer must not take down the server that serves the local session.
    const peers = parseDeclaredPeers("bad,alsobad=,worse=host:notaport,oracle=host:7682");
    expect(peers.map((peer) => peer.id)).toEqual(["oracle"]);
  });

  it("keeps a host that carries a port-like colon only once", () => {
    expect(parseDeclaredPeers("oracle=127.0.0.1:7682")[0]?.host).toBe("127.0.0.1");
  });
});

describe("mergeSidecars", () => {
  const board: LiveSidecar[] = [{ id: "agent", label: "Agent", host: "127.0.0.1", port: 7682 }];
  const declared = [{ id: "oracle", label: "oracle", host: "oracle", port: 7682 }];

  it("includes a declared peer that answered recently", () => {
    const live = mergeSidecars(board, declared, new Map([["oracle", NOW]]), NOW);
    expect([...live.keys()].sort()).toEqual(["agent", "oracle"]);
    expect(live.get("oracle")?.host).toBe("oracle");
  });

  it("drops a declared peer that has stopped answering", () => {
    // The probe is the remote peer's heartbeat, so the same staleness rule has to apply to it, or
    // the picker keeps offering a machine that is off and every request 502s.
    const live = mergeSidecars(board, declared, new Map([["oracle", NOW - SIDECAR_STALE_MS - 1]]), NOW);
    expect([...live.keys()]).toEqual(["agent"]);
  });

  it("drops a declared peer that has never answered", () => {
    expect([...mergeSidecars(board, declared, new Map(), NOW).keys()]).toEqual(["agent"]);
  });

  it("lets a board peer win a name collision", () => {
    const live = mergeSidecars(
      [{ id: "oracle", label: "local oracle", host: "127.0.0.1", port: 9000 }],
      declared,
      new Map([["oracle", NOW]]),
      NOW,
    );
    expect(live.get("oracle")).toEqual({
      id: "oracle", label: "local oracle", host: "127.0.0.1", port: 9000,
    });
  });
});

describe("indexFor", () => {
  it("puts the running account first with no id, then the rest by label", () => {
    const live = new Map<string, LiveSidecar>([
      ["oracle", { id: "oracle", label: "oracle", host: "oracle", port: 7682 }],
      ["dev", { id: "dev", label: "dev", host: "127.0.0.1", port: 7682 }],
      ["agent", { id: "agent", label: "Agent", host: "127.0.0.1", port: 7782 }],
    ]);
    expect(indexFor(live, "dev")).toEqual([
      { label: "dev" },
      { id: "agent", label: "Agent" },
      { id: "oracle", label: "oracle" },
    ]);
  });

  it("still names the default session when it has not announced itself", () => {
    expect(indexFor(new Map(), "dev")).toEqual([{ label: "dev" }]);
  });
});
