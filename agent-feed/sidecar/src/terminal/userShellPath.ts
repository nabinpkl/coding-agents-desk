// The PATH a person's own terminal has, for the commands this sidecar launches on their behalf.
//
// A launch runs through `zsh -l -c`: a login shell, but not an interactive one, so it reads
// ~/.zprofile and never ~/.zshrc. Whatever is put on PATH only in ~/.zshrc is then missing from
// the session. Measured on the Oracle peer (2026-10-15): bun's own installer adds ~/.bun/bin in
// ~/.zshrc, so a session the panel launched could not start a stdio MCP server configured as a
// bare `bun` (ENOENT) and left its Bot offline on the hub, while a session opened by hand from an
// interactive shell on the same machine connected.
//
// So the PATH is asked of an interactive login shell, which reads both, and each launch sets it
// after its own login profile has run. Asked once per process, because ~/.zshrc can be slow (a
// framework, a version manager) and a launch should not pay that each time; an edit to it reaches
// launches when the sidecar next restarts. Bounded, because an interactive rc can wait on input
// or start something that never exits, and fenced, because it can print (a greeting, an instant
// prompt) onto the same stdout. When it fails, it says why and launches go on as before.

const SHELL = "/bin/zsh";
const TIMEOUT_MS = 5_000;
const OPEN = "<agentdesk-path>";
const CLOSE = "</agentdesk-path>";

let resolution: Promise<string | undefined> | undefined;

/** The interactive login shell's PATH, resolved on first use, or undefined when it could not be. */
export function userShellPath(): Promise<string | undefined> {
  resolution ??= resolveUserShellPath().then((outcome) => {
    if ("path" in outcome) return outcome.path;
    console.error(`agent feed launches keep the login shell's PATH: ${outcome.failed}`);
    return undefined;
  });
  return resolution;
}

export async function resolveUserShellPath({
  env = process.env,
  timeoutMs = TIMEOUT_MS,
}: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<
  { path: string } | { failed: string }
> {
  let child;
  try {
    child = Bun.spawn([SHELL, "-l", "-i", "-c", `print -rn -- "${OPEN}$PATH${CLOSE}"`], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error) {
    return { failed: `${SHELL} could not be started (${String(error)})` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  // Raced against a timer rather than awaited: an rc that waits on something, or leaves a background
  // job holding stdout, would otherwise hold the read open, and every launch behind it.
  const out = await Promise.race([new Response(child.stdout).text(), timedOut]);
  clearTimeout(timer);
  if (out === undefined) {
    child.kill("SIGKILL");
    return { failed: `${SHELL} -l -i did not answer within ${timeoutMs}ms` };
  }
  const start = out.lastIndexOf(OPEN);
  const end = out.lastIndexOf(CLOSE);
  const path = start >= 0 && end > start ? out.slice(start + OPEN.length, end) : "";
  if (!path.includes("/")) {
    return { failed: `${SHELL} -l -i finished without printing a PATH` };
  }
  return { path };
}
