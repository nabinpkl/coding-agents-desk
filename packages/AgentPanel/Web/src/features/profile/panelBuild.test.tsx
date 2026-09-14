import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  PANEL_BUILD_ID,
  usePanelBuild,
  type DevServerHooks,
} from "@/features/profile/panelBuild";
import { PANEL_BUILD_ROUTE } from "@/features/profile/panelBuildRoute";

/** A stand-in for Vite's HMR client, so the events can be fired on demand. */
function devServer() {
  const listeners = new Map<string, Set<() => void>>();
  const hooks: DevServerHooks = {
    on: (event, listener) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
    },
    off: (event, listener) => listeners.get(event)?.delete(listener),
  };
  return {
    hooks,
    emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
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
