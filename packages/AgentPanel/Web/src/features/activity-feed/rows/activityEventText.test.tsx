import { describe, expect, it } from "vitest";
import {
  eventPreview,
  isFlowBlock,
  shellCommand,
  stripInlineMarkdown,
  toolIntent,
} from "@/features/activity-feed/rows/activityEventText";

describe("event preview", () => {
  it("strips the markers a one-line preview cannot render", () => {
    // A reasoning trace opening with a bolded topic put `**` on screen in the
    // collapsed row and the sticky bar -- the same defect as rendering the body
    // as plain text, one layer out.
    expect(
      eventPreview({
        index: 1,
        ts: 1,
        type: "reasoning",
        blocks: [{ kind: "reasoning", text: "**Adjusting skip handling**\n\nmore" }],
      }),
    ).toBe("Adjusting skip handling");
  });

  it("takes the first content block, whatever kind it is", () => {
    expect(
      eventPreview({
        index: 2,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Bash", summary: "ls -la" }],
      }),
    ).toBe("ls -la");
  });

  it("names a harness state line by its label, not '(no content)'", () => {
    // A metadata block IS the content of these lines -- the whole event is one
    // labelled dump. Scanning only text, tool and reasoning blocks made every such
    // row in the raw view read as a chip beside "(no content)", which is exactly the
    // rows the raw view exists to show.
    expect(
      eventPreview({
        index: 4,
        ts: 1,
        type: "system",
        blocks: [{ kind: "metadata", label: "Hook", text: '{"exitCode":0}' }, { kind: "raw" }],
      }),
    ).toBe('Hook: {"exitCode":0}');

    // Label alone when there is no body, and body alone when there is no label.
    expect(
      eventPreview({
        index: 5,
        ts: 1,
        type: "system",
        blocks: [{ kind: "metadata", label: "Date Change" }],
      }),
    ).toBe("Date Change");
    expect(
      eventPreview({
        index: 6,
        ts: 1,
        type: "system",
        blocks: [{ kind: "plain", text: "unrecognized record" }],
      }),
    ).toBe("unrecognized record");
  });

  it("prefers real content over a metadata block on the same event", () => {
    // The adapters append Working Directory to nearly every Claude line, so a
    // metadata-first scan would label half the thread with a file path.
    expect(
      eventPreview({
        index: 7,
        ts: 1,
        type: "assistant",
        blocks: [
          { kind: "text", text: "Done." },
          { kind: "metadata", label: "Working Directory", text: "/repo" },
        ],
      }),
    ).toBe("Done.");
  });

  it("caps the line so one long paragraph cannot stretch a row", () => {
    const preview = eventPreview({
      index: 3,
      ts: 1,
      type: "assistant",
      blocks: [{ kind: "text", text: "x".repeat(400) }],
    });
    expect(preview).toHaveLength(200);
  });

  it("leaves prose that merely contains asterisks alone", () => {
    expect(stripInlineMarkdown("2 * 3 * 4 equals 24")).toBe("2 * 3 * 4 equals 24");
  });

  it("unwraps headings, bullets, quotes, emphasis and code spans", () => {
    expect(stripInlineMarkdown("## Heading")).toBe("Heading");
    expect(stripInlineMarkdown("- a bullet")).toBe("a bullet");
    expect(stripInlineMarkdown("> quoted")).toBe("quoted");
    expect(stripInlineMarkdown("_underscored_ and *starred*")).toBe("_underscored_ and starred");
    expect(stripInlineMarkdown("call `render()` now")).toBe("call render() now");
  });
});

describe("flow blocks", () => {
  it("names exactly the kinds that may sit beside the floated heading", () => {
    // Anything else is a bordered box, which a float overlaps rather than
    // flows around, so it has to clear.
    expect(isFlowBlock({ kind: "text", text: "x" })).toBe(true);
    expect(isFlowBlock({ kind: "reasoning", text: "x" })).toBe(true);
    expect(isFlowBlock({ kind: "tool_use", tool: "Bash" })).toBe(false);
    expect(isFlowBlock({ kind: "tool_result", preview: "x" })).toBe(false);
    expect(isFlowBlock({ kind: "metadata", label: "m", text: "x" })).toBe(false);
    expect(isFlowBlock({ kind: "plain", label: "p", text: "x" })).toBe(false);
  });
});

describe("shell command extraction", () => {
  it("prefers the raw input the macOS panel receives", () => {
    expect(
      shellCommand({
        kind: "tool_use",
        tool: "Bash",
        summary: "git log --oneline",
        input: { command: "git log --oneline --graph --decorate --all" },
      }),
    ).toBe("git log --oneline --graph --decorate --all");
  });

  it("falls back to the summary when the wire dropped the input", () => {
    expect(shellCommand({ kind: "tool_use", tool: "shell", summary: "ls -la" })).toBe("ls -la");
    // Codex `shell` can carry argv rather than a command string.
    expect(
      shellCommand({
        kind: "tool_use",
        tool: "shell",
        summary: "ls -la",
        input: { command: ["bash", "-lc", "ls -la"] },
      }),
    ).toBe("ls -la");
  });

  it("returns null for tools that do not run a shell command", () => {
    expect(shellCommand({ kind: "tool_use", tool: "Read", summary: "Read App.tsx" })).toBeNull();
    expect(shellCommand({ kind: "text", text: "prose" })).toBeNull();
  });
});

describe("toolIntent", () => {
  const bash = (input: Record<string, unknown>) => ({
    blocks: [{ kind: "tool_use" as const, tool: "Bash", summary: "just check", input }],
  });

  it("reads the agent's description off a tool call", () => {
    // It rides the role heading; the command stays on the tool row, so both are visible at once.
    expect(toolIntent(bash({ command: "just check", description: "Run 2-hour looped logger" }))).toBe(
      "Run 2-hour looped logger",
    );
  });

  it("is null when the call carried no description, leaving the heading as it was", () => {
    expect(toolIntent(bash({ command: "just check" }))).toBeNull();
    expect(toolIntent(bash({ command: "just check", description: "   " }))).toBeNull();
  });

  it("ignores blocks that are not tool calls", () => {
    expect(toolIntent({ blocks: [{ kind: "text", text: "describe this" }] })).toBeNull();
  });

  it("takes the first description when an event ran several calls at once", () => {
    // A heading is one line. The rest keep their own rows.
    expect(
      toolIntent({
        blocks: [
          { kind: "tool_use", tool: "Read", input: { file_path: "/a" } },
          { kind: "tool_use", tool: "Bash", input: { command: "a", description: "first" } },
          { kind: "tool_use", tool: "Bash", input: { command: "b", description: "second" } },
        ],
      }),
    ).toBe("first");
  });
});
