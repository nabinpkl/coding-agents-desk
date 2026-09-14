import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  PANEL_BUILD_ID,
  usePanelConnected,
  type DevServerHooks,
} from "@/features/profile/panelBuild";

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

describe("panel build id", () => {
  it("names itself even when the bundler substituted nothing", () => {
    // Vitest applies no `define`, which is the same shape as a build where git could not answer.
    // Shown rather than hidden: a build that cannot say what it is, is the problem this row exists
    // to make visible.
    expect(PANEL_BUILD_ID).toBe("unknown");
  });
});

describe("dev server connection", () => {
  it("reports connected when there is no dev server to lose", () => {
    // A bundled build cannot go stale against a server it does not have, so warning about one
    // would be a warning about nothing.
    // `null`, not `undefined`: undefined would fall through to the default argument, which under
    // Vitest is its own partial hot context rather than nothing.
    const { result } = renderHook(() => usePanelConnected(null));
    expect(result.current).toBe(true);
  });

  it("goes stale when the page stops hearing from the dev server, and back on reconnect", () => {
    const server = devServer();
    const { result } = renderHook(() => usePanelConnected(server.hooks));

    expect(result.current).toBe(true);
    act(() => server.emit("vite:ws:disconnect"));
    expect(result.current).toBe(false);
    act(() => server.emit("vite:ws:connect"));
    expect(result.current).toBe(true);
  });

  it("stops listening when the row unmounts", () => {
    const server = devServer();
    const { unmount } = renderHook(() => usePanelConnected(server.hooks));

    expect(server.listening("vite:ws:disconnect")).toBe(1);
    unmount();
    expect(server.listening("vite:ws:disconnect")).toBe(0);
    expect(server.listening("vite:ws:connect")).toBe(0);
  });
});
