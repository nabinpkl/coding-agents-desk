// The icon table is generated data, so what is worth testing is the RESOLUTION rule over it, plus
// the one property the whole point of the change rests on: that the icons carry colour.

import { expect, it } from "vitest";
import { iconNameFor, shapeFor } from "@/features/workspace-ide/sidebar/FileIcon";

it("prefers a whole filename over the extension inside it", () => {
  // `package.json` is the npm mark, not the generic JSON one. Getting this backwards is invisible
  // until a tree of configs all draw the same braces.
  expect(iconNameFor("package.json")).not.toBe(iconNameFor("settings.json"));
  expect(iconNameFor("settings.json")).toBe("json");
});

it("prefers the longest matching extension", () => {
  // `docker-compose.yml` is a compose file before it is a YAML file, which is the precedence VS
  // Code resolves icon themes with.
  expect(iconNameFor("docker-compose.yml")).toBe("docker");
  expect(iconNameFor("anything.yml")).toBe("yaml");
});

it("matches regardless of case, because a filesystem does not care", () => {
  expect(iconNameFor("README.MD")).toBe(iconNameFor("readme.md"));
});

it("knows the languages this repo is written in", () => {
  expect(iconNameFor("main.swift")).toBe("swift");
  expect(iconNameFor("server.ts")).toBe("typescript");
  expect(iconNameFor("App.tsx")).toBe("react_ts");
  expect(iconNameFor("Justfile")).toBe("just");
});

it("draws a colour for a known type and no colour for an unknown one", () => {
  // The reason the generated table is here at all. An icon that carries its own `fill` is what
  // makes a language findable by eye; the fallback deliberately does not, so it takes the row's
  // muted tone and reads as "just a file" rather than asserting a language.
  expect(shapeFor("main.swift").body).toContain("fill=");
  expect(shapeFor("notes.unheardof").body).not.toContain("fill=");
});

it("falls back rather than throwing on a name with no extension at all", () => {
  expect(iconNameFor("LICENCE-with-no-dot")).toBeNull();
  expect(shapeFor("LICENCE-with-no-dot").viewBox).toBe("0 0 16 16");
});
