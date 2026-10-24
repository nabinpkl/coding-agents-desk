import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULTS,
  findHits,
  loadRules,
  parseRules,
  runGate,
  runHistory,
  scanBytes,
  scanText,
} from "./public-scan.mjs";

// A made-up string stands in for a personal one, so this file cannot trip the real denylist.
const MARKER = "zebra-sprocket";
const MARKER_RULE = `marker /${MARKER}/i\n`;

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" });
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "public-scan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  const denylistPath = join(dir, ".denylist");
  await writeFile(denylistPath, MARKER_RULE);
  await writeFile(join(dir, ".gitignore"), ".denylist\nignored.txt\nbaseline.tsv\n");
  return {
    dir,
    options: { root: dir, secretRulesPath: DEFAULTS.secretRulesPath, denylistPath, baselinePath: join(dir, "baseline.tsv") },
  };
}

test("rules parse with flags, and malformed, empty-matching or duplicate ones fail loudly", async (t) => {
  const [rule] = parseRules("# comment\n\nname /Abc(?!def)/i\n", "rules");
  assert.equal(rule.id, "name");
  assert.equal(findHits("x ABC y abcdef", [rule]).length, 1);
  assert.throws(() => parseRules("name abc\n", "rules"), /rules:1: expected/);
  assert.throws(() => parseRules("Name /abc/\n", "rules"), /expected/);
  assert.throws(() => parseRules("name /abc/g\n", "rules"), /flags from imsuv/);
  assert.throws(() => parseRules("loose /a*/\n", "rules"), /matches an empty string/);
  assert.throws(() => parseRules("\nbroken /(/\n", "rules"), /rules:2:/);
  const { options } = await fixture(t);
  await writeFile(options.denylistPath, "secret-jwt /x/\n");
  assert.throws(() => loadRules(options), /secret-jwt is defined twice/);
});

test("text hidden in base64 is found on the run's line, and binary that decodes to noise is not", () => {
  const rules = parseRules(MARKER_RULE, "rules");
  const hidden = Buffer.from(`{"cwd":"/home/${MARKER}/work","note":"padding padding padding"}`).toString("base64");
  const noise = Buffer.from(Array.from({ length: 96 }, (_, index) => (index * 37) % 256)).toString("base64");
  const hits = scanText(`first line\n"data":"${hidden}"\n"other":"${noise}"\n`, rules);
  assert.deepEqual(hits, [{ rule: "marker", line: 2, how: "base64" }]);
});

test("a binary file is read through its printable runs", () => {
  const rules = parseRules(MARKER_RULE, "rules");
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`Author: ${MARKER}`), Buffer.from([0, 255])]);
  assert.deepEqual(scanBytes(bytes, rules), [{ rule: "marker", line: 0, how: "binary" }]);
});

test("a secret shape fails the gate whatever the denylist says", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, "config.txt"), `key = ${"sk-" + "ant-" + "a".repeat(30)}\n`);
  const result = runGate(options);
  assert.equal(result.status, 1);
  assert.match(result.out.join("\n"), /secret-anthropic-key {2}config\.txt:1/);
});

test("the gate allows only what the baseline recorded, and the baseline only shrinks", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, "notes.md"), `one\n${MARKER}\nthree\n${MARKER}\n`);
  git(dir, "add", "notes.md", ".gitignore");
  git(dir, "commit", "-q", "-m", "notes");

  const first = runGate(options);
  assert.equal(first.status, 1);
  assert.match(first.out.join("\n"), /marker {2}notes\.md:2, 4/);

  assert.equal(runGate({ ...options, update: true }).status, 0);
  assert.match(await readFile(options.baselinePath, "utf8"), /^2\tmarker\tnotes\.md$/m);
  const clean = runGate(options);
  assert.equal(clean.status, 0);
  assert.match(clean.out.join("\n"), /OK, .* 2 baselined hits left in 1 files/);

  // Untracked files count, because `just check` treats them as part of the change; ignored ones do not.
  await writeFile(join(dir, "draft.txt"), `${MARKER}\n`);
  await writeFile(join(dir, "ignored.txt"), `${MARKER}\n`);
  const untracked = runGate(options);
  assert.equal(untracked.status, 1);
  assert.match(untracked.out.join("\n"), /marker {2}draft\.txt:1/);
  assert.doesNotMatch(untracked.out.join("\n"), /ignored\.txt/);
  await rm(join(dir, "draft.txt"));

  // A third hit in a baselined file is new even though the file already had some.
  await writeFile(join(dir, "notes.md"), `${MARKER}\n${MARKER}\n${MARKER}\n`);
  assert.match(runGate(options).out.join("\n"), /notes\.md:1, 2, 3 {3}\(2 of these were already there\)/);

  // Removing one without recording it fails too, so the improvement cannot be spent elsewhere.
  await writeFile(join(dir, "notes.md"), `${MARKER}\n`);
  const stale = runGate(options);
  assert.equal(stale.status, 1);
  assert.match(stale.out.join("\n"), /marker {2}notes\.md {2}2 -> 1/);
});

test("a path is matched as well as the contents", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, `${MARKER}-notes.txt`), "nothing inside\n");
  assert.match(runGate(options).out.join("\n"), new RegExp(`marker {2}${MARKER}-notes\\.txt:0`));
});

test("without a denylist the secret shapes still run, and the baseline is never rewritten", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, "notes.md"), `${MARKER}\n`);
  assert.equal(runGate({ ...options, update: true }).status, 0);
  await rm(options.denylistPath);
  const result = runGate(options);
  assert.equal(result.status, 0);
  assert.match(result.out.join("\n"), /no denylist at .*personal-data rules skipped/);
  assert.match(result.out.join("\n"), /1 baseline entries are for rules not loaded here/);
  assert.throws(() => runGate({ ...options, update: true }), /refusing to rewrite the baseline/);
});

test("history mode finds what the tree no longer holds: old blobs, messages and identities", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, "old.txt"), `${MARKER}\n`);
  git(dir, "add", "old.txt", ".gitignore");
  git(dir, "commit", "-q", "-m", "add old");
  git(dir, "rm", "-q", "old.txt");
  git(dir, "commit", "-q", "-m", `drop the ${MARKER} file`);
  git(dir, "-c", `user.email=dev@${MARKER}.test`, "commit", "-q", "--allow-empty", "-m", "empty");

  assert.equal(runGate(options).status, 0);
  const { rules } = loadRules(options);
  const result = await runHistory({ root: dir, rules, revisions: ["main"], gitleaks: false });
  const text = result.out.join("\n");
  assert.equal(result.status, 1);
  assert.match(text, /old\.txt @[0-9a-f]{8}/);
  assert.match(text, /commit [0-9a-f]{8} message/);
  assert.match(text, /commit [0-9a-f]{8} identity/);

  const range = await runHistory({ root: dir, rules, revisions: ["main~1..main"], gitleaks: false });
  assert.match(range.out.join("\n"), /identity/);
  assert.doesNotMatch(range.out.join("\n"), /old\.txt|message/);
});

test("history mode refuses to run without gitleaks rather than pass without it", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, "fine.txt"), "nothing here\n");
  git(dir, "add", "fine.txt", ".gitignore");
  git(dir, "commit", "-q", "-m", "fine");
  const { rules } = loadRules(options);
  await assert.rejects(
    runHistory({ root: dir, rules, revisions: ["main"], gitleaks: join(dir, "no-such-gitleaks") }),
    /gitleaks over the same commits, and `.*no-such-gitleaks` is not installed/,
  );
});

test("a clean history says so", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, "fine.txt"), "nothing here\n");
  git(dir, "add", "fine.txt", ".gitignore");
  git(dir, "commit", "-q", "-m", "fine");
  const { rules } = loadRules(options);
  const result = await runHistory({ root: dir, rules, revisions: ["main"], gitleaks: false });
  assert.equal(result.status, 0);
  assert.match(result.out.join("\n"), /history clean: 2 blobs/);
});
