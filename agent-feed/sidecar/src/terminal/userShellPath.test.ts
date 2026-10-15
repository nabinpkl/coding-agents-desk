import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUserShellPath } from "@/terminal/userShellPath";
import { ptyShellArguments } from "@/terminal/agentTerminalBackends";

// A home whose ~/.zshrc, and only its ~/.zshrc, puts a directory on PATH -- the shape bun's own
// installer leaves -- and prints on the way, as a greeting or an instant prompt would.
const home = mkdtempSync(join(tmpdir(), "agentdesk-user-path-"));
const zshrcOnly = join(home, "zshrc-only", "bin");
writeFileSync(join(home, ".zshrc"), `echo "welcome back"\nexport PATH="${zshrcOnly}:$PATH"\n`);
const env = { HOME: home, ZDOTDIR: home, PATH: "/usr/bin:/bin" };

afterAll(() => rmSync(home, { recursive: true, force: true }));

const run = (argv: string[]): string =>
  new TextDecoder().decode(Bun.spawnSync(argv, { env, stdin: "ignore" }).stdout);

test("a login shell that is not interactive misses what only ~/.zshrc puts on PATH", () => {
  // The gap itself, so the test below is answering the question that was actually broken.
  expect(run(["/bin/zsh", "-l", "-c", 'printf %s "$PATH"'])).not.toContain(zshrcOnly);
});

test("reads the PATH of an interactive login shell, past whatever its rc prints", async () => {
  const outcome = await resolveUserShellPath({ env });
  expect("path" in outcome && outcome.path.split(":")[0]).toBe(zshrcOnly);
});

test("an rc that never finishes is a reason, not a hang", async () => {
  const stuck = mkdtempSync(join(tmpdir(), "agentdesk-user-path-stuck-"));
  try {
    writeFileSync(join(stuck, ".zshrc"), "sleep 30\n");
    const started = Date.now();
    const outcome = await resolveUserShellPath({ env: { ...env, HOME: stuck, ZDOTDIR: stuck }, timeoutMs: 300 });
    expect(outcome).toEqual({ failed: expect.stringContaining("did not answer within 300ms") });
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    rmSync(stuck, { recursive: true, force: true });
  }
});

test("a PTY command runs with the resolved PATH, after the login profile has had its say", () => {
  const path = `${zshrcOnly}:/usr/bin:/bin`;
  const argv = ptyShellArguments(["/bin/sh", "-c", 'printf %s "$PATH"'], path);
  expect(run(["/bin/zsh", ...argv])).toBe(path);
  // Without one it launches as it always did, and with no command it is the shell.
  expect(ptyShellArguments(["claude"], undefined)).toEqual(["-l", "-c", 'exec "$0" "$@"', "claude"]);
  expect(ptyShellArguments([], path)).toEqual(["-l"]);
});
