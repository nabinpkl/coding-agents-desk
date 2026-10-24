#!/usr/bin/env python3
"""Run a shell command in a Screen Sharing login session, event-based, no blind sleeps.

Connect, wait for the pixel stream to prove the session is live, then prove INPUT is live the only
way this server allows -- by observing an effect. Both sessions share /Users/Shared, so a marker
file touched by a typed command is visible from here the instant it lands. The driver keeps clearing
the line and re-typing the marker command until the file appears, which also absorbs the ~2s the
server drops input after connect: no fixed wait, it simply retries until a keystroke takes. Only
then does it type the real command, and it confirms that landed the same way, by a second marker.

    session-drive.py USER 'shell command to run'

The command runs in the session's foreground Terminal. Anything the command writes to
/Users/Shared is readable here; that is the whole return path.
"""
import importlib.util, pathlib, secrets, sys, time

# session-client.py is a script, not a package, so it is loaded by path from beside this file.
CLIENT = pathlib.Path(__file__).resolve().parent / "session-client.py"
spec = importlib.util.spec_from_file_location("sc", CLIENT)
sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)

SHARED = pathlib.Path("/Users/Shared")


def until(predicate, timeout, step=0.15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return False


def forget(path):
    """Best-effort remove. A marker is written by the OTHER session and owned by that user, so
    this user cannot always unlink it; a stale one is harmless because every attempt uses a new nonce."""
    try:
        path.unlink()
    except OSError:
        pass


def type_line(session, text):
    """Reset the prompt to a clean state, type one line, submit it.

    Ctrl-C first, not just Ctrl-U: a keystroke dropped in the post-connect window can leave the
    shell at a `>` continuation prompt (an unbalanced quote), where Ctrl-U and Return only extend
    the continuation. Ctrl-C aborts any partial or continuation line back to a fresh prompt; Ctrl-U
    then clears anything typed on it, and only then is the line ours to write."""
    session.tap(0x63, [0xFFE3])  # ctrl+c, abort any partial or continuation line
    session.tap(0x75, [0xFFE3])  # ctrl+u, kill whatever is left on the line
    session.write(text + "\n")


def await_input(session, timeout=20):
    """Return once a typed command demonstrably ran, by racing a marker file into existence.

    Retries the whole type-and-submit rather than waiting a guessed interval, so it works whether
    the server is 1s or 5s from accepting input, and recovers if a submit was among the dropped
    keystrokes."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        marker = SHARED / f".vnc-ready-{secrets.token_hex(4)}"  # new each attempt, so no false hit
        type_line(session, f": > {marker}")  # ':' is a shell no-op; the redirect is the whole point
        if until(marker.exists, 1.0):
            forget(marker)
            return True
    raise SystemExit("input never took: no marker after retries; is a shell focused in that session?")


def run(session, command, timeout=25):
    """Type the real command, then prove IT ran with its own marker appended to the same line."""
    done = SHARED / f".vnc-done-{secrets.token_hex(4)}"
    type_line(session, f"{command} ; : > {done}")
    if not until(done.exists, timeout):
        raise SystemExit(f"command did not signal completion within {timeout}s")
    forget(done)


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    user, command = sys.argv[1], sys.argv[2]
    session = sc.Session(user)
    print(f"connected as {user}: {session.width}x{session.height} named {session.name!r}")
    session.wait_pixels()
    print("pixel stream live")
    await_input(session)
    print("input confirmed live")
    run(session, command)
    print("command completed")
    time.sleep(0.3)
    session.sock.close()


if __name__ == "__main__":
    main()
