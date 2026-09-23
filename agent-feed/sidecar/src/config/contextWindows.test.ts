import { expect, test } from "bun:test";
import { contextWindowIn } from "@/config/contextWindows";

const TABLE = {
  "claude-opus": 200_000,
  "claude-sonnet": 200_000,
  opus: 200_000,
} as const;

test("a model whose id carries the long-context tier gets the long window", () => {
  // `claude-opus-5[1m]` and `claude-opus-5` are the same model run with different windows, and
  // the brackets are the whole of what says so -- Claude Code 2.1.270 resolves it by exactly
  // this test before it consults anything else.
  expect(contextWindowIn(TABLE, "claude-opus-5[1m]")).toBe(1_000_000);
  expect(contextWindowIn(TABLE, "claude-opus-5")).toBe(200_000);
});

test("the tier is read whatever case it is written in, and wherever it appears", () => {
  expect(contextWindowIn(TABLE, "claude-opus-5[1M]")).toBe(1_000_000);
  // A model the table has never heard of still answers, because the tier is a property of the
  // id and not of the row it would have matched.
  expect(contextWindowIn(TABLE, "claude-fable-5-1[1m]")).toBe(1_000_000);
  expect(contextWindowIn(TABLE, "claude-fable-5-1")).toBeNull();
});

test("a table row that names the tier itself outranks the rule", () => {
  // The environment override exists to correct this build's idea of a window. A row written
  // about the tiered id is about this exact run, so it wins; the 200k rows are not.
  const corrected = { ...TABLE, "claude-opus-5[1m]": 500_000 };
  expect(contextWindowIn(corrected, "claude-opus-5[1m]")).toBe(500_000);
  expect(contextWindowIn(corrected, "claude-opus-5")).toBe(200_000);
});

test("the longest matching prefix still wins among rows that do not name a tier", () => {
  const table = { ...TABLE, "claude-opus-4": 150_000 };
  expect(contextWindowIn(table, "claude-opus-4-8")).toBe(150_000);
  expect(contextWindowIn(table, "claude-opus-5")).toBe(200_000);
  expect(contextWindowIn(table, undefined)).toBeNull();
});
