// Which grammar a name asks for. Pure, and the only part of the highlighter that can be wrong
// without a browser: everything else is shiki's, and the rest of this module is plumbing that
// either fetches a grammar or leaves the text plain.
//
// The thing being pinned is that ONE function answers for a fence language and a file name alike.
// They arrive from different surfaces -- a transcript's ```ts and the IDE's useWorkspaceIde.ts --
// and the bug this replaces was a second resolver in the IDE that only understood extensions, so
// every file whose name IS its type rendered grey.

import { expect, test } from "vitest";
import { grammarWanted } from "@/features/activity-feed/markdown/highlighter";

test("reads a fence language as itself, because shiki's registry already knows the short names", () => {
  expect(grammarWanted("ts")).toBe("ts");
  expect(grammarWanted("yml")).toBe("yml");
  expect(grammarWanted("rb")).toBe("rb");
});

test("reads a file by its extension, and takes the last one", () => {
  expect(grammarWanted("src/features/useWorkspaceIde.ts")).toBe("ts");
  expect(grammarWanted("src/app/main.tsx")).toBe("tsx");
  expect(grammarWanted("agent-feed/wire/index.d.ts")).toBe("ts");
});

test("reads a file whose NAME is its type", () => {
  // The case that sent this looking: a Justfile has no extension, so an extension-only resolver
  // asked for nothing and the file rendered grey in an editor that highlights everything else.
  expect(grammarWanted("Justfile")).toBe("just");
  expect(grammarWanted("tools/justfile")).toBe("just");
  expect(grammarWanted("Makefile")).toBe("make");
  expect(grammarWanted("Dockerfile")).toBe("docker");
  expect(grammarWanted(".zshrc")).toBe("bash");
});

test("reads the Apple formats that are XML wearing another extension", () => {
  expect(grammarWanted("Info.plist")).toBe("xml");
  expect(grammarWanted("AgentDeskHost.entitlements")).toBe("xml");
  expect(grammarWanted("icon.svg")).toBe("xml");
});

test("reaches the body of a dotfile that has more name after it", () => {
  expect(grammarWanted(".env")).toBe("dotenv");
  expect(grammarWanted(".env.local")).toBe("dotenv");
});

test("takes the names an editor emits that shiki does not have", () => {
  expect(grammarWanted("typescriptreact")).toBe("tsx");
  expect(grammarWanted("javascriptreact")).toBe("jsx");
  expect(grammarWanted("golang")).toBe("go");
  expect(grammarWanted("htm")).toBe("html");
});

test("is not case sensitive, because neither are the names people type", () => {
  expect(grammarWanted("README.MD")).toBe("md");
  expect(grammarWanted("JUSTFILE")).toBe("just");
  expect(grammarWanted("TS")).toBe("ts");
});

test("asks for nothing when there is nothing to ask about", () => {
  expect(grammarWanted("")).toBe("text");
  expect(grammarWanted("   ")).toBe("text");
});

test("passes an unknown name through rather than deciding it is plain", () => {
  // Whether a grammar exists is shiki's registry to answer, not this function's. Guessing "text"
  // here would mean a language shiki gained could never reach it without an edit to this file.
  expect(grammarWanted("some-language-nobody-has")).toBe("some-language-nobody-has");
  expect(grammarWanted(".gitignore")).toBe("gitignore");
});
