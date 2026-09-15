import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  PANEL_BUILD_ID,
  usePanelBuild,
  type DevServerHooks,
} from "@/features/profile/panelBuild";
import {
  PANEL_BUILD_ROUTE,
  PANEL_PUBLISH_EVENT,
  PANEL_PUBLISH_ROUTE,
  type PanelBuildReport,
} from "@/features/profile/panelBuildRoute";

/** A stand-in for Vite's HMR client, so the events can be fired on demand. */
function devServer() {
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const hooks: DevServerHooks = {
    on: (event, listener) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
    },
    off: (event, listener) => listeners.get(event)?.delete(listener),
  };
  return {
    hooks,
    emit: (event: string, data?: unknown) =>
      listeners.get(event)?.forEach((listener) => listener(data)),
    listening: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

/** Answers the build route with one id, and records what was asked for. */
function serveBuild(build: string | Error) {
  const asked: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    asked.push(String(input));
    if (build instanceof Error) throw build;
    return new Response(JSON.stringify({ build }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return { asked };
}

/** Answers both routes with a whole report, and records the requests in order. */
function serveReport(report: Partial<PanelBuildReport> & { build: string }) {
  const asked: { url: string; method: string }[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return { asked };
}

afterEach(() => vi.unstubAllGlobals());

describe("panel build id", () => {
  it("names itself even when the bundler substituted nothing", () => {
    // Vitest applies no `define`, which is the same shape as a build where git could not answer.
    // Shown rather than hidden: a build that cannot say what it is, is the problem this row exists
    // to make visible.
    expect(PANEL_BUILD_ID).toBe("unknown");
  });

  it("reads the tree from the dev server rather than trusting what was compiled in", async () => {
    // The measurement this exists for: `define` substitutes one reading when Vite loads its
    // config, so the compiled constant names the last server restart. It read `f2dffa6+` while
    // HEAD was `7373cec` and the tree was clean, two commits later.
    const server = devServer();
    const { asked } = serveBuild("7373cec");
    const { result } = renderHook(() => usePanelBuild(server.hooks));

    expect(asked).toEqual([PANEL_BUILD_ROUTE]);
    await waitFor(() => expect(result.current.id).toBe("7373cec"));
  });

  it("re-reads on every applied update, which is when the tree can have moved", async () => {
    const server = devServer();
    const { asked } = serveBuild("7373cec");
    const { result } = renderHook(() => usePanelBuild(server.hooks));
    await waitFor(() => expect(result.current.id).toBe("7373cec"));

    serveBuild("2ec54a0+");
    act(() => server.emit("vite:afterUpdate"));
    await waitFor(() => expect(result.current.id).toBe("2ec54a0+"));
    expect(asked).toEqual([PANEL_BUILD_ROUTE]);
  });

  it("says unknown when the server cannot answer, rather than the id it was compiled with", async () => {
    // Falling back to the constant would put a frozen id back on the row looking exactly like a
    // live one, which is the failure this replaces.
    const server = devServer();
    serveBuild(new Error("no route"));
    const { result } = renderHook(() => usePanelBuild(server.hooks));

    await waitFor(() => expect(result.current.id).toBe("unknown"));
  });

  it("keeps the compiled id when there is no server to ask", () => {
    // A bundled build: the constant IS the tree, because the bundle is frozen.
    const { asked } = serveBuild("should-not-be-asked");
    const { result } = renderHook(() => usePanelBuild(null));

    expect(result.current.id).toBe(PANEL_BUILD_ID);
    expect(asked).toEqual([]);
  });
});

describe("dev server connection", () => {
  it("reports connected when there is no dev server to lose", () => {
    // A bundled build cannot go stale against a server it does not have, so warning about one
    // would be a warning about nothing.
    // `null`, not `undefined`: undefined would fall through to the default argument, which under
    // Vitest is its own partial hot context rather than nothing.
    const { result } = renderHook(() => usePanelBuild(null));
    expect(result.current.connected).toBe(true);
  });

  it("goes stale when the page stops hearing from the dev server, and back on reconnect", async () => {
    const server = devServer();
    serveBuild("7373cec");
    const { result } = renderHook(() => usePanelBuild(server.hooks));
    // Settle the mount read first, so its state lands inside the test rather than after it.
    await waitFor(() => expect(result.current.id).toBe("7373cec"));

    expect(result.current.connected).toBe(true);
    act(() => server.emit("vite:ws:disconnect"));
    expect(result.current.connected).toBe(false);

    // Coming back re-reads too: the tree is exactly what may have moved while the page was deaf.
    serveBuild("723fcbe");
    act(() => server.emit("vite:ws:connect"));
    expect(result.current.connected).toBe(true);
    await waitFor(() => expect(result.current.id).toBe("723fcbe"));
  });

  it("stops listening to the publisher too when the row unmounts", async () => {
    const server = devServer();
    serveBuild("7373cec");
    const { result, unmount } = renderHook(() => usePanelBuild(server.hooks));
    await waitFor(() => expect(result.current.id).toBe("7373cec"));

    expect(server.listening(PANEL_PUBLISH_EVENT)).toBe(1);
    unmount();
    expect(server.listening(PANEL_PUBLISH_EVENT)).toBe(0);
  });

  it("stops listening when the row unmounts", async () => {
    const server = devServer();
    serveBuild("7373cec");
    const { result, unmount } = renderHook(() => usePanelBuild(server.hooks));
    await waitFor(() => expect(result.current.id).toBe("7373cec"));

    expect(server.listening("vite:ws:disconnect")).toBe(1);
    expect(server.listening("vite:afterUpdate")).toBe(1);
    unmount();
    expect(server.listening("vite:ws:disconnect")).toBe(0);
    expect(server.listening("vite:ws:connect")).toBe(0);
    expect(server.listening("vite:afterUpdate")).toBe(0);
  });
});

// The gate deliberately keeps a page behind the tree until it typechecks, so "not updating" now has
// two meanings that look the same from the outside. These are what tells them apart.
describe("work the dev server is holding", () => {
  it("reads what is held and why from the same route as the build", async () => {
    const server = devServer();
    serveReport({
      build: "7373cec+",
      held: ["ActivityBlockViews.tsx", "panelBuild.ts"],
      blocked: "panelBuild.ts(91,5): error TS2322: Type 'null' is not assignable.",
      checking: false,
      unfiltered: false,
    });
    const { result } = renderHook(() => usePanelBuild(server.hooks));

    await waitFor(() => expect(result.current.held).toHaveLength(2));
    expect(result.current.blocked).toContain("error TS2322");
    expect(result.current.checking).toBe(false);
  });

  it("takes a pushed report without asking again", async () => {
    const server = devServer();
    const { asked } = serveReport({ build: "7373cec" });
    const { result } = renderHook(() => usePanelBuild(server.hooks));
    await waitFor(() => expect(result.current.id).toBe("7373cec"));

    act(() =>
      server.emit(PANEL_PUBLISH_EVENT, {
        build: "7373cec+",
        held: ["main.tsx"],
        blocked: null,
        checking: true,
        unfiltered: false,
      }),
    );
    expect(result.current.held).toEqual(["main.tsx"]);
    expect(result.current.checking).toBe(true);
    // One read on mount, and nothing since: the push carries the whole report.
    expect(asked).toHaveLength(1);
  });

  it("asks the server to hand the work over, and takes the answer", async () => {
    const server = devServer();
    serveReport({ build: "7373cec", held: ["main.tsx"], blocked: "main.tsx(1,1): error TS1005: ';'" });
    const { result } = renderHook(() => usePanelBuild(server.hooks));
    await waitFor(() => expect(result.current.held).toEqual(["main.tsx"]));

    const { asked } = serveReport({ build: "7373cec", held: [], blocked: null });
    act(() => result.current.publish());
    await waitFor(() => expect(result.current.held).toEqual([]));
    expect(asked).toEqual([{ url: PANEL_PUBLISH_ROUTE, method: "POST" }]);
    expect(result.current.blocked).toBeNull();
  });

  it("has nothing to publish in a build with no dev server behind it", () => {
    const { asked } = serveReport({ build: "should-not-be-asked" });
    const { result } = renderHook(() => usePanelBuild(null));

    act(() => result.current.publish());
    expect(asked).toEqual([]);
    expect(result.current.held).toEqual([]);
    expect(result.current.unfiltered).toBe(false);
  });
});
