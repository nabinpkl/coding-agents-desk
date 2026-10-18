// The one way this package shells out, and where the two binaries it needs really live.

/** Injected so tests never fork. Returns stdout; a failed command yields an empty string. */
export type CommandRunner = (argv: readonly string[]) => Promise<string>;

/**
 * Absolute, because this process is not started from a shell.
 *
 * The sidecar is spawned by the Mac host, and PATH resolution there is not the PATH resolution a
 * developer sees in their terminal. Resolving by name works right up until it does not, and the
 * failure is invisible: an empty answer from `lsof` reads exactly like "this session is running
 * nothing". The repo already carries this scar for `/usr/bin/log`, which has to be invoked
 * absolutely for the same class of reason.
 */
export const PS_BINARY = "/bin/ps";
export const LSOF_BINARY = "/usr/sbin/lsof";

export const runCommand: CommandRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv as string[], {
      stdout: "pipe",
      stderr: "pipe",
      // The C locale, because we PARSE this output.
      //
      // `ps -o lstart=` is locale-formatted. Under the Mac host's inherited `LANG=en_CA.UTF-8`
      // it prints `Fri 14 Aug 13:10:48 2026` -- day before month -- where a C-locale shell prints
      // `Fri Aug 14 13:10:48 2026`. Every session was then rejected as a pid-reuse mismatch, and
      // the panel reported no background work at all, on a machine that had plenty.
      env: { ...process.env, LC_ALL: "C" },
    });
    const [text, diagnostic] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    // A non-zero exit is an ordinary answer here: `lsof` exits non-zero when a pid has already
    // gone. Producing NOTHING while complaining on stderr is not -- that is the tool declining to
    // run, and it used to be indistinguishable from a quiet machine.
    if (code !== 0 && !text && diagnostic.trim()) {
      console.error(
        JSON.stringify({
          event: "agent-feed-task-probe-failed",
          command: argv[0],
          exitCode: code,
          detail: diagnostic.trim().slice(0, 200),
        }),
      );
    }
    return text;
  } catch (error) {
    // Could not be started at all -- missing binary, denied exec. Loud, because the alternative
    // is a panel that quietly reports no background work forever.
    console.error(
      JSON.stringify({
        event: "agent-feed-task-probe-unavailable",
        command: argv[0],
        detail: String(error).slice(0, 200),
      }),
    );
    return "";
  }
};
