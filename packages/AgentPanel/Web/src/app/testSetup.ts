import "@testing-library/jest-dom";

// Node's experimental Web Storage global shadows jsdom under Bun-spawned Vitest unless Node was
// given a persistence file. Replace it without reading the warning-producing getter, keeping the
// browser contract deterministic with the same in-memory semantics jsdom normally supplies.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  } satisfies Storage,
});
