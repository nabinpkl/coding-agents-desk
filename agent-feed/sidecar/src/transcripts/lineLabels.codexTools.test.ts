// The labels a Codex custom tool call gets: the command an exec ran, the files a patch touches,
// and what the verbs that are not shell commands did. Split from the labels' main suite, which
// covers the other kinds of row.

import { expect, test } from "bun:test";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import { codexAdapter } from "@/transcripts/codex/codexTranscript";

function blocks(adapter: typeof claudeAdapter | typeof codexAdapter, record: unknown) {
  return adapter.processLine(JSON.stringify(record))?.event?.blocks ?? [];
}

function customToolCall(name: string, input: string) {
  return blocks(codexAdapter, {
    timestamp: "2026-07-30T12:00:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      id: "ctc_1",
      status: "completed",
      call_id: "call_XGkI1GjICR7m4HFnHRcLarCo",
      name,
      input,
    },
  })[0];
}

test('an exec call names the command it ran instead of the word "exec"', () => {
  // `custom_tool_call.input` is JavaScript source, not JSON, so `parseArgs` came
  // back empty and every one of the 21,672 exec calls across these rollouts
  // summarized as the single string "exec". The collapsed preview keeps only the
  // first line, so all 21,672 rows were mutually indistinguishable.
  expect(
    customToolCall(
      "exec",
      'const r = await tools.exec_command({cmd:"git status --short",workdir:"/repo",yield_time_ms:10000}); text(r.output)',
    )?.summary,
  ).toBe("git status --short");

  // Codex also writes the argument keys quoted. Same row either way.
  expect(
    customToolCall(
      "exec",
      'const r = await tools.exec_command({"cmd":"rg -n needle","workdir":"/repo"}); text(r.output)',
    )?.summary,
  ).toBe("rg -n needle");

  // A Promise.all fan-out names the first command and counts the rest; 1,395 of
  // these carry between 2 and 11 commands.
  expect(
    customToolCall(
      "exec",
      [
        "const results = await Promise.all([",
        '  tools.exec_command({cmd:"just check",workdir:"/repo"}),',
        '  tools.exec_command({cmd:"git log -1",workdir:"/repo"}),',
        "]);",
      ].join("\n"),
    )?.summary,
  ).toBe("just check  (+1 more)");
});

test("a cmd: written inside a shell command is not read as an argument", () => {
  // The reader steps over string literals rather than scanning inside them. A
  // regex to /cmd\s*:/ would have taken the echoed text as the real command.
  expect(
    customToolCall(
      "exec",
      'const r = await tools.exec_command({cmd:"echo \\"cmd: not-this\\" | tee log",workdir:"/repo"})',
    )?.summary,
  ).toBe('echo "cmd: not-this" | tee log');
});

test("a patch names the files it touches instead of carrying the diff into the row", () => {
  // All 17,065 apply_patch payloads here open with `*** Begin Patch` and every one
  // of them summarized as the bare string "apply_patch".
  const patch = [
    "*** Begin Patch",
    "*** Update File: /repo/host/AgentDeskHost/AgentWindow/AgentWindowController.swift",
    "@@",
    "-let a = 1",
    "+let a = 2",
    "*** End Patch",
  ].join("\n");
  expect(customToolCall("apply_patch", patch)?.summary).toBe("M AgentWindowController.swift");
  expect(customToolCall("apply_patch", patch)?.summary).not.toContain("let a = 2");

  // The same patch handed to `exec` as a JavaScript string has its line breaks
  // written as the two characters backslash-n, which no line-oriented pattern
  // stops at. Without cutting there the "path" ran on and pulled the whole diff
  // into the row -- exactly the failure this replaces.
  const scripted =
    'const patch = "*** Begin Patch\\n*** Update File: /repo/REVIEW_LOG.md\\n@@\\n-old row\\n+new row\\n*** End Patch\\n"; text(await tools.apply_patch(patch))';
  expect(customToolCall("exec", scripted)?.summary).toBe("apply_patch M REVIEW_LOG.md");

  // Add and delete are distinguished, and past six files the rest are counted.
  const many = ["*** Begin Patch"]
    .concat(["a", "b", "c", "d", "e", "f", "g"].map((n) => `*** Add File: /repo/${n}.swift`))
    .concat(["*** Delete File: /repo/old.swift", "*** End Patch"])
    .join("\n");
  expect(customToolCall("apply_patch", many)?.summary).toBe(
    "A a.swift, A b.swift, A c.swift, A d.swift, A e.swift, A f.swift, +2 more",
  );
});

test("a patch that adds a line mentioning tools. is still read as a patch", () => {
  // Dispatching on "does this text contain tools." would read this as a script and
  // label the row with a verb picked out of the patched file's own contents.
  const patch = [
    "*** Begin Patch",
    "*** Update File: /repo/AGENTS.md",
    "@@",
    "+Call tools.exec_command when you need a shell.",
    "*** End Patch",
  ].join("\n");
  expect(customToolCall("apply_patch", patch)?.summary).toBe("M AGENTS.md");
});

test("the exec verbs that are not shell commands say what they did", () => {
  // 6,000 of the 21,672 exec calls drive something other than a shell. Each names
  // its verb, since unlike a command the verb is not visible in the detail.
  expect(
    customToolCall(
      "exec",
      'const r = await tools.write_stdin({session_id:24659,chars:"",yield_time_ms:1000}); text(JSON.stringify(r))',
    )?.summary,
  ).toBe("write_stdin session 24659  (poll)");
  expect(
    customToolCall("exec", 'const r = await tools.write_stdin({session_id:24659,chars:"y\\n"}); text(r.output)')
      ?.summary,
  ).toBe("write_stdin session 24659  y");

  expect(
    customToolCall(
      "exec",
      'const r = await tools.web__run({search_query:[{q:"quic datagram nwconnectiongroup"},{q:"network framework multistream"}]})',
    )?.summary,
  ).toBe("web__run quic datagram nwconnectiongroup  (+1 more)");
  // A fetch carries no query; the targets name the row instead of leaving it bare.
  expect(
    customToolCall("exec", 'const r = await tools.web__run({open:[{ref_id:"https://example.com/docs"}]})')?.summary,
  ).toBe("web__run https://example.com/docs");

  expect(
    customToolCall(
      "exec",
      'const r = await tools.view_image({path:"/tmp/run/01-two-windows.png",detail:"original"}); image(r.image_url)',
    )?.summary,
  ).toBe("view_image 01-two-windows.png");

  expect(
    customToolCall(
      "exec",
      'const r = await tools.update_plan({plan:[{step:"Map the wiring",status:"in_progress"},{step:"Add a failing test",status:"pending"}]})',
    )?.summary,
  ).toBe("update_plan 2 steps · Map the wiring");

  // The sub-agent namespace prefix carries no information in a row.
  expect(
    customToolCall(
      "exec",
      'const r = await tools.multi_agent_v1__send_input({target:"019f4a6a-c76d-7993-9795-d0e47174b025",message:"Implement lane A"})',
    )?.summary,
  ).toBe("send_input Implement lane A");
  expect(
    customToolCall(
      "exec",
      'const r = await tools.multi_agent_v1__wait_agent({targets:["019f4a6a-c76d-7993","019f4a6a-cc16-7f12"]})',
    )?.summary,
  ).toBe("wait_agent 2 agents");

  // A verb with no rule of its own is named by its first real argument, which
  // covers the MCP tail without a rule per server.
  expect(
    customToolCall(
      "exec",
      'const r = await tools.mcp__context7__query_docs({libraryId:"/websites/mlx",query:"lazy evaluation cold start"}); text(r)',
    )?.summary,
  ).toBe("mcp__context7__query_docs /websites/mlx");
});

test("a script whose command is computed names the verb rather than inventing a command", () => {
  // 256 exec calls build their commands in a loop, so no literal sits at `cmd`.
  // The next literal in the source is a workdir, and reporting that as the command
  // would be worse than saying nothing. The rule declines, and the row says which
  // verb ran without claiming to know its argument.
  const looped = [
    'const cmds = [["status","git status --short"],["stat","git diff --stat"]];',
    'for (const [name, c] of cmds) { const r = await tools.exec_command({cmd:c,workdir:"/repo/host"}); text(r.output); }',
  ].join("\n");
  expect(customToolCall("exec", looped)?.summary).toBe("exec_command");
  expect(customToolCall("exec", looped)?.summary).not.toContain("/repo/host");

  // A script that calls no tool at all is left alone too.
  expect(customToolCall("exec", 'text(ALL_TOOLS.map(x => x.name).join("\\n"))')?.summary).toBe("exec");
});

test("a long command is cut to a row, not carried whole", () => {
  const long = `rg -n '${"needle|".repeat(200)}' /repo`;
  const summary =
    customToolCall("exec", `const r = await tools.exec_command({cmd:${JSON.stringify(long)},workdir:"/repo"})`)
      ?.summary ?? "";
  expect(summary.length).toBeLessThanOrEqual(200);
  expect(summary.startsWith("rg -n")).toBe(true);
});
