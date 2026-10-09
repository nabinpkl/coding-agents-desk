import { expect, test } from "bun:test";
import { permissionModeOn } from "@/input/permissionModeFooter";

const screen = (footer: string) => [
  "  Some earlier output from the session.",
  "────────",
  "❯ ",
  "────────",
  "  agent-desk  Opus 5 (1M context)                    0 tokens",
  footer,
].join("\n");

test("each footer the CLI draws names its mode", () => {
  expect(permissionModeOn(screen("  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"))).toBe("auto");
  expect(permissionModeOn(screen("  ⏵⏵ accept edits on (shift+tab to cycle)"))).toBe("acceptEdits");
  expect(permissionModeOn(screen("  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent"))).toBe("plan");
  expect(permissionModeOn(screen("  ⏵⏵ bypass permissions on (shift+tab to cycle)"))).toBe("bypassPermissions");
  expect(permissionModeOn(screen("  ⏸ manual mode on · ← 1 agent"))).toBe("manual");
});

test("colour on the footer does not hide it", () => {
  expect(permissionModeOn(screen("  \u001b[38;5;211m⏵⏵ bypass permissions on\u001b[39m (shift+tab to cycle)")))
    .toBe("bypassPermissions");
});

test("the session's own words about a mode, far above the footer, are not the footer", () => {
  const prose = ["  ⏸ plan mode on is what I would use here.", ...Array(12).fill("  more output")].join("\n");
  expect(permissionModeOn(`${prose}\n${screen("  agent-desk  0 tokens")}`)).toBeNull();
});
