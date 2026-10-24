#!/usr/bin/env python3
"""Drive a Mac's Screen Sharing from a terminal, when a graphical client is too slow to use.

A viewer has to decode a video stream to show you anything. This sends input directly and fetches
a picture only when you ask for one, so it stays usable on a machine that is thrashing or a link
that is thin. It is not a replacement for a viewer; it is what you use when the viewer will not do.

    python3 tools/vnc-drive.py [user] [host]     (user defaults to the one running this)

The password is read with getpass: never echoed, never stored, never placed in your shell history,
and never passed through anything but this process. Type `help` once connected.
"""
import getpass
import importlib.util
import os
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sc", HERE / "session-client.py")
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)

HELP = """
  shot [file]          save a picture of the screen (default /tmp/vnc-shot.png)
  shot x y w h [file]  save one region, which is much faster than the whole screen
  click X Y            press and release at a point
  move X Y             move the pointer without pressing
  type TEXT            type the rest of the line literally
  secret               prompt for text and type it WITHOUT echoing, for a password field
  key CHORD            one key, e.g. return, tab, escape, cmd+q
  size                 report the framebuffer size
  quit
"""


def save(session, path, box):
    session.set_encodings([sc.RAW])
    session.request(*box)
    for rx, ry, rw, rh, _, data in session.update():
        rows = [
            bytes(
                b
                for i in range(0, rw * 4, 4)
                for b in (data[r * rw * 4 + i + 2], data[r * rw * 4 + i + 1], data[r * rw * 4 + i])
            )
            for r in range(rh)
        ]
        sc.write_png(path, rw, rh, rows)
        print(f"  wrote {rw}x{rh} from ({rx},{ry}) to {path} ({os.path.getsize(path)} bytes)")


def main():
    if any(flag in sys.argv[1:] for flag in ("-h", "--help")):
        print(__doc__)
        return
    user = sys.argv[1] if len(sys.argv) > 1 else getpass.getuser()
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    # Handed to the client directly rather than through the environment, so it never reaches a
    # child process, a log, or the shell that started this.
    os.environ.pop("VNC_PASS", None)
    secret = getpass.getpass(f"password for {user}@{host} (not echoed, not stored): ")
    sc.password = lambda: secret

    session = sc.Session(user, host=host)
    print(f"connected as {user}: framebuffer {session.width}x{session.height} named {session.name!r}")
    print("a fresh login screen and your own desktop look very different here; `shot` to see which.")
    print(HELP)

    while True:
        try:
            line = input("vnc> ").strip()
        except EOFError:
            break
        if not line:
            continue
        verb, _, rest = line.partition(" ")
        rest = rest.strip()
        try:
            if verb == "quit":
                break
            elif verb == "help":
                print(HELP)
            elif verb == "size":
                print(f"  {session.width}x{session.height}")
            elif verb == "shot":
                parts = rest.split()
                numbers = [p for p in parts if p.lstrip("-").isdigit()]
                names = [p for p in parts if p not in numbers]
                box = tuple(int(n) for n in numbers[:4]) if len(numbers) >= 4 else (0, 0, session.width, session.height)
                save(session, names[0] if names else "/tmp/vnc-shot.png", box)
            elif verb == "click":
                x, y = (int(v) for v in rest.split()[:2])
                session.click(x, y)
                print(f"  clicked {x},{y}")
            elif verb == "move":
                x, y = (int(v) for v in rest.split()[:2])
                session.pointer(x, y)
                print(f"  pointer {x},{y}")
            elif verb == "type":
                session.write(rest)
                print(f"  typed {len(rest)} characters")
            elif verb == "secret":
                # For a password field: read without echo and send it as keystrokes. It is not
                # printed, not kept, and not visible to anyone reading this terminal later.
                value = getpass.getpass("  text (not echoed): ")
                session.write(value)
                print(f"  typed {len(value)} characters")
                del value
            elif verb == "key":
                keysym, modifiers = sc.parse_chord(rest)
                session.tap(keysym, modifiers)
                print(f"  sent {rest}")
            else:
                print("  unknown; try help")
        except SystemExit as error:
            print(f"  {error}")
        except Exception as error:  # a driving mistake must not end the session
            print(f"  {type(error).__name__}: {error}")
        time.sleep(0.05)

    session.sock.close()


if __name__ == "__main__":
    main()
