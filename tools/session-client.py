#!/usr/bin/env python3
"""A small RFB client for the Screen Sharing session belonging to another user on this Mac.

macOS starts a separate, concurrent login session when a Screen Sharing client authenticates as a
user who is not the one at the console. That session has its own display, its own active
application and its own keyboard focus, which is why input sent here behaves normally: a command
shortcut reaches the active app there without touching the console user's focus.

Apple's own client refuses to connect to the Mac it runs on, so this speaks the protocol directly:
RFB with Apple's Diffie-Hellman and AES credential exchange, security type 30.

    export VNC_USER=agent
    security add-generic-password -a agent -s deskzoom-vnc -w   # once, instead of a file
    python3 tools/session-client.py watch [seconds]
    python3 tools/session-client.py shot out.png [x y w h]
    python3 tools/session-client.py move 400 300
    python3 tools/session-client.py click 400 300 [left|right|middle]
    python3 tools/session-client.py key tab
    python3 tools/session-client.py type hello world
    python3 tools/session-client.py encodings [x y w h]

The password comes from the login Keychain, or from VNC_PASS when no Keychain item exists, so it
never lands in a shell history or a transcript.
"""
import hashlib
import os
import secrets
import socket
import struct
import subprocess
import sys
import time
import zlib

RAW, COPY_RECT, ZLIB, ZRLE = 0, 1, 6, 16
# The server discards input for a moment after a connection opens. Measured 2026-09-04: pointer and
# key events sent immediately were dropped every time, and the same events after a settle landed
# three times out of three. This is a wait before the first input, not a blanket sleep.
INPUT_SETTLE = 2.5
KEYCHAIN_SERVICE = "deskzoom-vnc"

# X11 keysyms. Printable ASCII is its own code; these are the keys that are not characters.
KEYSYMS = {
    "return": 0xFF0D, "enter": 0xFF0D, "tab": 0xFF09, "space": 0x20,
    "delete": 0xFF08, "backspace": 0xFF08, "forward-delete": 0xFFFF,
    "escape": 0xFF1B, "esc": 0xFF1B,
    "up": 0xFF52, "down": 0xFF54, "left": 0xFF51, "right": 0xFF53,
    "home": 0xFF50, "end": 0xFF57, "page-up": 0xFF55, "page-down": 0xFF56,
}
# Command arrives as Super on Apple's server, measured 2026-09-04: Meta_L did nothing at all,
# Super_L opened Spotlight. Meta is kept only so a chord that wants it can still be spelled.
MODIFIERS = {
    "cmd": 0xFFEB, "command": 0xFFEB, "super": 0xFFEB, "meta": 0xFFE7,
    "shift": 0xFFE1, "ctrl": 0xFFE3, "control": 0xFFE3,
    "alt": 0xFFE9, "option": 0xFFE9, "opt": 0xFFE9,
}
BUTTONS = {"left": 1, "middle": 2, "right": 4}


def password():
    found = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True)
    if found.returncode == 0:
        return found.stdout.rstrip("\n")
    if "VNC_PASS" in os.environ:
        return os.environ["VNC_PASS"]
    raise SystemExit(f"no password: add one with `security add-generic-password -a $VNC_USER "
                     f"-s {KEYCHAIN_SERVICE} -w`, or set VNC_PASS")


class Session:
    """One RFB connection. Reads are blocking; nothing here is threaded on purpose."""

    def __init__(self, user, host="127.0.0.1", port=5900):
        self.sock = socket.create_connection((host, port), timeout=30)
        self.version = self._authenticate(user, password())
        self.width, self.height, self.name = self._handshake()
        self._opened = time.time()
        self._input_ready = False

    def _read(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(min(n - len(data), 1 << 20))
            if not chunk:
                raise ConnectionError(f"server closed after {len(data)} of {n} bytes")
            data += chunk
        return data

    def _authenticate(self, user, secret):
        version = self._read(12).decode().strip()
        self.sock.sendall(b"RFB 003.008\n")
        count = self._read(1)[0]
        if count == 0:
            raise SystemExit("server refused: " + self._read(struct.unpack(">I", self._read(4))[0]).decode())
        types = list(self._read(count))
        if 30 not in types:
            raise SystemExit(f"no Apple authentication on offer, only {types}")
        self.sock.sendall(bytes([30]))

        generator, key_length = struct.unpack(">HH", self._read(4))
        prime = int.from_bytes(self._read(key_length), "big")
        server_public = int.from_bytes(self._read(key_length), "big")
        private = secrets.randbits(key_length * 8) % prime
        shared = pow(server_public, private, prime).to_bytes(key_length, "big")
        aes_key = hashlib.md5(shared).digest()

        def field(text):
            raw = text.encode()[:63] + b"\0"
            return raw + secrets.token_bytes(64 - len(raw))

        # The system openssl does AES-128-ECB without padding, so no Python crypto package is needed.
        credentials = subprocess.run(
            ["/usr/bin/openssl", "enc", "-aes-128-ecb", "-K", aes_key.hex(), "-nopad"],
            input=field(user) + field(secret), capture_output=True, check=True).stdout
        self.sock.sendall(credentials + pow(generator, private, prime).to_bytes(key_length, "big"))

        if struct.unpack(">I", self._read(4))[0] != 0:
            raise SystemExit("authentication failed; check the account and its Screen Sharing access")
        return version

    def _handshake(self):
        self.sock.sendall(b"\x01")  # ClientInit, shared session
        width, height = struct.unpack(">HH", self._read(4))
        self._read(16)  # the server's pixel format, replaced below
        name = self._read(struct.unpack(">I", self._read(4))[0]).decode(errors="replace")
        # Plain 32-bit true colour keeps the decoder below a memory copy.
        self.sock.sendall(b"\x00\x00\x00\x00" + struct.pack(">BBBBHHHBBBxxx", 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
        return width, height, name

    def set_encodings(self, encodings):
        self.sock.sendall(struct.pack(">BxH", 2, len(encodings)) + b"".join(struct.pack(">i", e) for e in encodings))

    # MARK: input

    def _await_input_ready(self):
        if self._input_ready:
            return
        remaining = INPUT_SETTLE - (time.time() - self._opened)
        if remaining > 0:
            time.sleep(remaining)
        self._input_ready = True

    def pointer(self, x, y, mask=0):
        self._await_input_ready()
        self.sock.sendall(struct.pack(">BBHH", 5, mask, x, y))

    def click(self, x, y, button="left"):
        """A press with a real duration. Down and up in the same instant is not a click anyone
        recognises: menus open on the press and dismiss on an immediate release, measured 2026-09-04."""
        self.pointer(x, y)
        time.sleep(0.08)
        self.pointer(x, y, BUTTONS[button])
        time.sleep(0.12)
        self.pointer(x, y, 0)
        time.sleep(0.08)

    def key(self, keysym, down):
        self._await_input_ready()
        self.sock.sendall(struct.pack(">BBxxI", 4, 1 if down else 0, keysym))

    def tap(self, keysym, modifiers=()):
        """Held briefly, for the same reason a click is."""
        for modifier in modifiers:
            self.key(modifier, True)
            time.sleep(0.05)
        self.key(keysym, True)
        time.sleep(0.08)
        self.key(keysym, False)
        time.sleep(0.05)
        for modifier in reversed(modifiers):
            self.key(modifier, False)
            time.sleep(0.03)

    def write(self, text):
        for character in text:
            self.tap(0xFF0D if character == "\n" else ord(character))

    # MARK: framebuffer

    def request(self, x, y, w, h, incremental=False):
        self.sock.sendall(struct.pack(">BBHHHH", 3, 1 if incremental else 0, x, y, w, h))

    def update(self):
        """One FramebufferUpdate as a list of (x, y, w, h, encoding, payload)."""
        while True:
            kind = self._read(1)[0]
            if kind == 0:
                break
            if kind == 2:  # Bell
                continue
            if kind == 3:  # ServerCutText
                self._read(3)
                self._read(struct.unpack(">I", self._read(4))[0])
                continue
            raise SystemExit(f"unexpected server message {kind}")
        self._read(1)
        rectangles = []
        for _ in range(struct.unpack(">H", self._read(2))[0]):
            x, y, w, h, encoding = struct.unpack(">HHHHi", self._read(12))
            rectangles.append((x, y, w, h, encoding, self._payload(encoding, w, h)))
        return rectangles

    def _payload(self, encoding, w, h):
        """The rectangle's bytes. ZRLE and zlib carry a length, so they can be measured without
        a full decoder; Raw is a fixed size; anything else this client did not ask for."""
        if encoding == RAW:
            return self._read(w * h * 4)
        if encoding in (ZRLE, ZLIB):
            return self._read(struct.unpack(">I", self._read(4))[0])
        if encoding == COPY_RECT:
            return self._read(4)
        raise SystemExit(f"server used encoding {encoding}, which this client did not advertise")


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    with open(path, "wb") as file:
        file.write(b"\x89PNG\r\n\x1a\n"
                   + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                   + chunk(b"IDAT", zlib.compress(raw, 6))
                   + chunk(b"IEND", b""))


def sessions():
    out = subprocess.run(["ps", "-axo", "user=,comm="], capture_output=True, text=True).stdout
    return sorted({line.split()[0] for line in out.splitlines() if line.rstrip().endswith("/loginwindow")})


def parse_chord(text):
    parts = text.lower().split("+")
    name = parts[-1]
    keysym = KEYSYMS.get(name, ord(name) if len(name) == 1 else None)
    if keysym is None:
        raise SystemExit(f"unknown key {name!r}; known: {', '.join(sorted(KEYSYMS))} or one character")
    modifiers = []
    for part in parts[:-1]:
        if part not in MODIFIERS:
            raise SystemExit(f"unknown modifier {part!r}; known: {', '.join(sorted(MODIFIERS))}")
        modifiers.append(MODIFIERS[part])
    return keysym, modifiers


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    user = os.environ.get("VNC_USER", "agent")
    command, rest = sys.argv[1], sys.argv[2:]

    if command == "watch":
        hold = int(rest[0]) if rest else 60
        before = sessions()
        print("login sessions before:", before)
        session = Session(user)
        print(f"authenticated as {user}, framebuffer {session.width}x{session.height} named {session.name!r}")
        deadline, seen = time.time() + hold, set(before)
        while time.time() < deadline:
            time.sleep(1)
            for who in [u for u in sessions() if u not in seen]:
                print(f"new login session for {who}")
                seen.add(who)
        print("login sessions after:", sessions())
        return

    session = Session(user)
    print(f"authenticated as {user}, framebuffer {session.width}x{session.height} named {session.name!r}")

    if command == "shot":
        out = rest[0]
        x, y, w, h = (int(v) for v in (rest[1:5] or (0, 0, 800, 500)))
        session.set_encodings([RAW])
        session.request(x, y, w, h)
        for rx, ry, rw, rh, _, data in session.update():
            rows = [bytes(b for i in range(0, rw * 4, 4)
                          for b in (data[r * rw * 4 + i + 2], data[r * rw * 4 + i + 1], data[r * rw * 4 + i]))
                    for r in range(rh)]
            write_png(out, rw, rh, rows)
            print(f"wrote {rw}x{rh} from ({rx},{ry}) to {out}")

    elif command == "encodings":
        x, y, w, h = (int(v) for v in (rest[0:4] or (0, 0, 1920, 1200)))
        for label, advertised in (("Raw", [RAW]), ("ZRLE", [ZRLE, COPY_RECT, RAW])):
            probe = Session(user)
            probe.set_encodings(advertised)
            start = time.time()
            probe.request(x, y, w, h)
            rectangles = probe.update()
            elapsed = time.time() - start
            total = sum(len(payload) for *_, payload in rectangles)
            kinds = sorted({encoding for *_, encoding, _ in rectangles})
            print(f"{label:5} advertised {advertised}: server used {kinds}, "
                  f"{total / 1e6:.2f} MB in {elapsed:.2f}s over {len(rectangles)} rectangles")
            probe.sock.close()

    elif command == "move":
        session.pointer(int(rest[0]), int(rest[1]))
        print(f"pointer to {rest[0]},{rest[1]}")

    elif command == "click":
        button = rest[2] if len(rest) > 2 else "left"
        session.click(int(rest[0]), int(rest[1]), button)
        print(f"{button} click at {rest[0]},{rest[1]}")

    elif command == "key":
        keysym, modifiers = parse_chord(rest[0])
        session.tap(keysym, modifiers)
        print(f"sent {rest[0]}")

    elif command == "type":
        text = " ".join(rest)
        session.write(text)
        print(f"typed {len(text)} characters")

    else:
        raise SystemExit(__doc__)

    time.sleep(0.4)  # input is fire-and-forget; give the server a moment before the socket closes
    session.sock.close()


if __name__ == "__main__":
    main()
