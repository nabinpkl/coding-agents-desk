/**
 * The picker's rows and the draft's meaning: filter as the name is typed, first match carrying
 * Return, and a draft that names a listed command splitting into the command and its arguments.
 * An unknown name is not a command, so it stays text the serve reads literally.
 */

import { describe, expect, it } from "vitest";
import {
  opencodeCommandRows,
  parseOpencodeCommand,
} from "@/features/session-view/composer/useOpencodeCommands";

const COMMANDS = [
  { name: "review", description: "review changes" },
  { name: "init", description: "guided setup" },
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

  it("matches arguments after the name without losing the row", () => {
    const rows = opencodeCommandRows(COMMANDS, "/review the last");
    expect(rows.map((row) => row.name)).toEqual(["/review"]);
  });
});

describe("the panel-owned models entry", () => {
  it("lists the picker after served commands and parses its filter", () => {
    const rows = opencodeCommandRows(COMMANDS, "/mo");
    expect(rows.map((row) => row.name)).toEqual(["/models"]);
    expect(parseOpencodeCommand(COMMANDS, "/models spark")).toEqual({ name: "models", args: "spark" });
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

  it("leaves an unknown name as text", () => {
    expect(parseOpencodeCommand(COMMANDS, "/nope nothing")).toBeNull();
    expect(parseOpencodeCommand(COMMANDS, "review this")).toBeNull();
  });
});
