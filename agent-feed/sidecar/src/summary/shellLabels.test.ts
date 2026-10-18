import { expect, test } from "bun:test";
import { heuristicShellLabel, redactCommandSecrets, stripCommandPrefixes } from "@/summary/shellLabels";

test("reads and greps name file and pattern", () => {
  expect(heuristicShellLabel("cat src/a.ts")).toBe("Read a.ts");
  expect(heuristicShellLabel(`grep -n "subscribe" src/feed.ts | head -3`)).toBe("Search for subscribe in src/feed.ts");
});

test("git chains join", () => {
  expect(heuristicShellLabel(`git status --short && git log --oneline -3`)).toBe(
    "Show working tree status, List commits",
  );
});

test("strips cd hops, env prefixes, and echo noise", () => {
  expect(heuristicShellLabel(`cd /repo && NODE_ENV=0 node run.mjs && echo done`)).toBe("Run run.mjs");
  expect(heuristicShellLabel(`export A=1`)).toBe("Set environment variables");
  // Shell's inline `VAR=val cmd` form keeps the command, not the assignment.
  expect(heuristicShellLabel(`ROW=3414 node a.mjs 2>&1 | tail -20`)).toBe("Run a.mjs");
});

test("heredoc names the file", () => {
  expect(heuristicShellLabel(`python3 - <<'PY'\np = "src/bots/reg.ts"\nprint(open(p).read())`)).toBe(
    "Edit reg.ts with script",
  );
});

test("grep patterns read as words, not syntax", () => {
  expect(heuristicShellLabel(`grep -n "test\\|watch" src/feed.ts`)).toBe("Search for test, watch in src/feed.ts");
  expect(heuristicShellLabel(`grep -E "^check: | pass$" out.log | head -5`)).toBe("Search for check:, pass in out.log");
});

test("pipes name every stage, tail adds nothing", () => {
  expect(
    heuristicShellLabel(`npx vitest run src/blocks/describeEditChange.test.ts 2>&1 | grep -B1 -A9 "FAIL " | head -30`),
  ).toBe("Test describeEditChange.test.ts, filter for FAIL");
  expect(heuristicShellLabel(`ROW=3414 node a.mjs 2>&1 | tail -20`)).toBe("Run a.mjs");
});

test("docker and curl have fixed shapes", () => {
  expect(heuristicShellLabel(`docker ps --format table`)).toBe("List running containers");
  expect(heuristicShellLabel(`curl -s https://relay.example.com/v1/directory | python3 -c "import json"`)).toBe(
    "Fetch relay.example.com, parsed",
  );
});

test("secrets redact out of the composed line", () => {
  expect(redactCommandSecrets(`curl -H "Authorization: Bearer abc123XYZtoken" https://x`)).toBe(
    `curl -H "Authorization: [REDACTED]" https://x`,
  );
  expect(stripCommandPrefixes(`export CF_SEC='cfast_TestSecret0123456789abcdef'`)).toBe("");
});
