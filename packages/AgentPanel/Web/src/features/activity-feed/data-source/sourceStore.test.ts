import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSourceStore, useSourceStore } from "@/features/activity-feed/data-source/sourceStore";

// The sidebar is mounted up to three times at once. Its widgets' data has to be one answer across
// those mounts, opened once, and closed only when the last of them has gone.
describe("a store per data source", () => {
  it("shares one entry between readers, and opens and closes it once", () => {
    const opened = vi.fn();
    const closed = vi.fn();
    const store = createSourceStore<object, number>({ initial: () => 0, opened, closed });
    const source = {};

    const first = renderHook(() => useSourceStore(store, source));
    const second = renderHook(() => useSourceStore(store, source));
    expect(opened).toHaveBeenCalledTimes(1);

    act(() => store.set(source, (count) => count + 1));
    expect(first.result.current).toBe(1);
    expect(second.result.current).toBe(1);

    first.unmount();
    expect(closed).not.toHaveBeenCalled();
    second.unmount();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("keeps what was known for the next reader, and keeps machines apart", () => {
    const store = createSourceStore<object, string>({ initial: () => "idle" });
    const mac = {};
    const peer = {};
    const reader = renderHook(() => useSourceStore(store, mac));
    act(() => store.set(mac, () => "ready"));
    reader.unmount();

    expect(renderHook(() => useSourceStore(store, mac)).result.current).toBe("ready");
    expect(renderHook(() => useSourceStore(store, peer)).result.current).toBe("idle");
  });
});
