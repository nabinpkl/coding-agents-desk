/**
 * The picker's rows and the draft's meaning: when there is a list at all, what it filters on,
 * and a draft that names a listed command splitting into the command and its arguments. An
 * unknown name is not a command, so it stays text the serve reads literally.
 *
 * The list closing on the first space is the web client's rule rather than a panel invention
 * (`/^\/(\S*)$/`, `packages/app/src/composer/suggestions/machine.ts`), and it is what makes
 * Return mean one thing: an open list completes a name, a closed one submits.
 */

import { describe, expect, it } from "vitest";
import { opencodeCommandRows, parseOpencodeCommand } from "@/features/session-view/composer/useOpencodeCommands";

const COMMANDS = [
  { name: "review", description: "review changes" },
  { name: "init", description: "guided setup" },
  { name: "model", aliases: ["models"], description: "Select a different model" },
];

describe("opencodeCommandRows", () => {
  it("shows nothing until the draft opens with a slash", () => {
    expect(opencodeCommandRows(COMMANDS, "hello")).toEqual([]);
    expect(opencodeCommandRows(COMMANDS, "")).toEqual([]);
  });

  it("filters by the name being typed, first match carrying Return", () => {
    const rows = opencodeCommandRows(COMMANDS, "/rev");
    expect(rows.map((row) => row.name)).toEqual(["/review"]);
    expect(rows[0]?.selected).toBe(true);
  });

  it("closes on the first space, so a draft with arguments has no list to complete", () => {
    expect(opencodeCommandRows(COMMANDS, "/review")).toHaveLength(1);
    expect(opencodeCommandRows(COMMANDS, "/review ")).toEqual([]);
    expect(opencodeCommandRows(COMMANDS, "/review the last")).toEqual([]);
  });

  it("matches an alias as well as the name, and offers the row once", () => {
    expect(opencodeCommandRows(COMMANDS, "/mod").map((row) => row.name)).toEqual(["/model"]);
    expect(opencodeCommandRows(COMMANDS, "/models").map((row) => row.name)).toEqual(["/model"]);
  });

  it("carries the description the sidecar sent, which is the web client's own wording", () => {
    expect(opencodeCommandRows(COMMANDS, "/model")[0]?.description).toBe("Select a different model");
  });
});

describe("parseOpencodeCommand", () => {
  it("splits a listed command from its arguments", () => {
    expect(parseOpencodeCommand(COMMANDS, "/review the last commit")).toEqual({
      name: "review",
      args: "the last commit",
    });
    expect(parseOpencodeCommand(COMMANDS, "/init")).toEqual({ name: "init", args: "" });
  });

  it("resolves an alias to the command it names, so `/models` reaches the picker", () => {
    expect(parseOpencodeCommand(COMMANDS, "/models spark")).toEqual({ name: "model", args: "spark" });
    expect(parseOpencodeCommand(COMMANDS, "/Model")).toEqual({ name: "model", args: "" });
  });

  it("leaves an unknown name as text", () => {
    expect(parseOpencodeCommand(COMMANDS, "/nope nothing")).toBeNull();
    expect(parseOpencodeCommand(COMMANDS, "review this")).toBeNull();
  });
});
