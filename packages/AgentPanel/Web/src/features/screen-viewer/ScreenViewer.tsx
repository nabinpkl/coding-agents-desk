import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import RFB from "@novnc/novnc";
import { useUnmountEffect } from "@/hooks/useMountEffect";

/**
 * The Mac's own Screen Sharing, in the panel.
 *
 * This is not the desktop viewer beside it, and the difference is the whole point. That one streams
 * a capture of a login session and posts input into it, which the window server ignores unless that
 * session is at the console -- so it shows a picture of a switched-away Mac and cannot type into it.
 * This speaks RFB to `screensharingd`, which injects input into whichever session it is showing,
 * including the login window. It is the way back in when the console is locked and nobody is there.
 *
 * The credentials are your macOS account's, they are typed here and go straight to the VNC
 * handshake in this page. They are not stored, not sent to the panel's own API, and never leave the
 * browser except into the connection you are opening.
 */
const BRIDGE_PATH = "/vnc";

/**
 * X11 keysyms for the keys that are not characters.
 *
 * A printable character's keysym is its own code point, so only these need naming. noVNC's own
 * mapping tables live in modules its package does not export, so this is the small subset a phone
 * actually sends rather than a copy of the whole thing.
 */
const KEYSYMS: Record<string, number> = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  Delete: 0xffff,
};

type Phase = "idle" | "connecting" | "connected" | "failed";

export function ScreenViewer() {
  const screen = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");

  const teardown = useCallback(() => {
    client.current?.disconnect();
    client.current = null;
  }, []);

  useUnmountEffect(teardown);

  function connect(event: React.SubmitEvent) {
    event.preventDefault();
    if (!screen.current) return;
    teardown();
    setPhase("connecting");
    setDetail("");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const rfb = new RFB(screen.current, `${scheme}://${window.location.host}${BRIDGE_PATH}`, {
      credentials: { username, password },
    });
    // The panel is a fixed box on a phone; scaling the framebuffer into it beats a scrollable
    // 3600-pixel-wide desktop that has to be panned to find the password field.
    rfb.scaleViewport = true;
    rfb.background = "#000";
    rfb.addEventListener("connect", () => {
      setPhase("connected");
      // Dropped as soon as the handshake has taken it, so it is not sitting in component state
      // for the life of the session.
      setPassword("");
    });
    // `securityfailure` fires first and knows why; `disconnect` follows for the same event and
    // knows only that the socket went. Without this the specific reason -- almost always a wrong
    // password -- was overwritten a moment later by "connection lost", which sends you looking at
    // the network instead of at what you typed.
    let explained = false;
    rfb.addEventListener("securityfailure", (event) => {
      explained = true;
      setPhase("failed");
      setDetail(event.detail?.reason || "the Mac rejected that user name or password");
    });
    rfb.addEventListener("disconnect", (event) => {
      setPhase("failed");
      if (explained) return;
      setDetail(
        event.detail?.clean
          ? "closed"
          : "connection lost before the desktop arrived -- check the user name and password",
      );
    });
    client.current = rfb;
  }

  /**
   * iOS shows a keyboard for a focused text field and for nothing else. noVNC's canvas takes focus
   * but is not a field, so a phone has no way to type into a remote Mac at all. Focusing an
   * offscreen textarea is what summons it; the characters it receives are forwarded as keysyms and
   * the field is emptied each time, so it never accumulates the text it is only being used to catch.
   */
  function sendText(text: string): void {
    for (const character of text) {
      client.current?.sendKey(character.codePointAt(0)!, null);
    }
  }

  function onCaptureKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const keysym = KEYSYMS[event.key];
    if (keysym === undefined) return;
    event.preventDefault();
    client.current?.sendKey(keysym, null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      {phase !== "connected" ? (
        <form onSubmit={connect} className="flex flex-wrap items-end gap-2 bg-background p-3">
          <label className="flex flex-col gap-1 text-(length:--agent-panel-fs-sidebar-meta,13px)">
            <span className="text-muted-foreground">macOS user</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-h-11 rounded-md border border-border bg-input/40 px-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-(length:--agent-panel-fs-sidebar-meta,13px)">
            <span className="text-muted-foreground">password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 rounded-md border border-border bg-input/40 px-2"
            />
          </label>
          <button
            type="submit"
            disabled={phase === "connecting" || username.length === 0}
            className="min-h-11 rounded-md bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {phase === "connecting" ? "Connecting…" : "Connect"}
          </button>
          {detail ? <p className="w-full text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">{detail}</p> : null}
        </form>
      ) : null}
      {phase === "connected" ? (
        <div className="flex shrink-0 items-center gap-2 bg-background px-3 py-2">
          <button
            type="button"
            onClick={() => {
              if (keyboard.current === document.activeElement) keyboard.current?.blur();
              else keyboard.current?.focus();
            }}
            className="min-h-11 rounded-md bg-muted px-3 font-medium text-foreground"
          >
            Keyboard
          </button>
          <button
            type="button"
            onClick={() => client.current?.disconnect()}
            className="min-h-11 rounded-md px-3 text-muted-foreground"
          >
            Disconnect
          </button>
        </div>
      ) : null}
      <div ref={screen} className="min-h-0 flex-1" />
      {createPortal(
        <textarea
          ref={keyboard}
          aria-label="Remote Mac keyboard input"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          tabIndex={-1}
          onKeyDown={onCaptureKeyDown}
          onChange={(event) => {
            sendText(event.currentTarget.value);
            event.currentTarget.value = "";
          }}
          // 16px because anything smaller makes iOS zoom the page when the field takes focus, and
          // pointer-events-none so a stray tap can never land on the thing catching the keystrokes.
          style={{ bottom: "8px", fontSize: 16 }}
          className="pointer-events-none fixed left-2 h-4 w-4 opacity-0"
        />,
        document.body,
      )}
    </div>
  );
}
