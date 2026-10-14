import { expect, test } from "vitest";
import { addressWithRun, runInAddress } from "@/features/arena/arenaAddress";

const RUN = "2f1c9a7e-4b1d-4c55-9a51-0d3f6b8e2a10";

test("an address names the run in its query, beside the tab", () => {
  expect(runInAddress(`?entry=arena&run=${RUN}`)).toBe(RUN);
  expect(runInAddress("?entry=arena")).toBeNull();
});

test("a value no run could have names no run, rather than reaching a request path", () => {
  expect(runInAddress("?run=..%2F..%2Fetc")).toBeNull();
  expect(runInAddress("?run=")).toBeNull();
  expect(runInAddress(`?run=${"a".repeat(65)}`)).toBeNull();
});

test("naming a run keeps the rest of the address, and naming none removes only the run", () => {
  const named = addressWithRun("https://mac.example:5173/?entry=arena#x", RUN);
  expect(named).toBe(`https://mac.example:5173/?entry=arena&run=${RUN}#x`);
  expect(addressWithRun(named, null)).toBe("https://mac.example:5173/?entry=arena#x");
});
