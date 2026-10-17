// Typing at a session that is already running somewhere else.
//
// The ways to reach the same box, which is why they sit together: a Claude Desktop window through
// the helper, and the session's own tmux pane, with the read that says which kind of session it
// is. (A CLI session's messaging socket was a third, removed 2026-10-16.) What they have in
// common is that this panel is never the thing holding the composer -- it asks for a state and is
// told what the box then holds, rather than tracking a local copy that would be wrong the moment
// somebody types at the machine itself.

import type {
  ClaudePermissionMode,
  ClaudeSdkCommandOutcome,
  ClaudeSdkDecideCommand,
  ClaudeRunMode,
  ClaudeSdkSessionState,
  ClaudeSdkSwitchOutcome,
  CliSessionStatus,
  ComposerImageDrop,
  ComposerKeyPress,
  RailKey,
  RailModifiers,
  TmuxComposerEnvelope,
  TmuxComposerState,
  TmuxPermissionModeOutcome,
  TmuxPermissionModeRequest,
  TmuxQuestionAnswer,
  TmuxQuestionOutcome,
  TmuxQuestionPoint,
  TmuxQuestionPointOutcome,
  TmuxQuestionState,
  WindowComposerEnvelope,
  WindowComposerStatus,
  WindowQuestionAction,
  WindowQuestionStatus,
} from "@agentdesk/agent-feed-wire";
import { parse, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarTranscript } from "@/features/activity-feed/data-source/layers/SidecarTranscript";

/** A session run through the Agent SDK, reached through its runner (ADR-0143). */
function claudeSdkPath(
  session: SessionAddress,
  action: "stream" | "prompt" | "answer" | "decide" | "mode" | "model" | "interrupt" | "switch",
): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/sdk/${action}`;
}

function cliSessionPath(session: SessionAddress): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/cli`;
}

/**
 * The tmux pane's composer, addressed the same way as the CLI session status above it.
 *
 * Claude-only on the sidecar, which refuses any other source from the route pattern; the source is
 * still interpolated rather than hardcoded so a mistaken call fails as a 404 instead of quietly
 * addressing the wrong session's pane.
 */
function tmuxComposerPath(
  session: SessionAddress,
  action: "" | "/submit" | "/accept" | "/image" | "/key" | "/mode" | "/stream" | `/paste/${string}` = "",
): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/composer${action}`;
}

/**
 * A blob's bytes as base64, without holding a second copy of them as a JS string of characters.
 *
 * `FileReader` rather than `btoa` over a byte string: the argument to `btoa` has to be built one
 * character at a time, which for a few megabytes of screenshot is a string longer than the image
 * and a loop the main thread notices. The reader hands back a `data:` URL and the base64 is
 * everything after its comma.
 *
 * Shared with the terminal tiles, whose drops ride the same bytes to a bare tmux pane rather
 * than to a Claude composer box.
 */
export function base64FromBlob(image: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      if (comma < 0) {
        reject(new Error("could not read the image"));
        return;
      }
      resolve(url.slice(comma + 1));
    };
    reader.readAsDataURL(image);
  });
}

export class SidecarComposers extends SidecarTranscript {
  // ---------------------------------------------------------------------
  // Claude Desktop composer and AskUserQuestion panel
  // ---------------------------------------------------------------------

  /**
   * One session's composer and question state, as they change.
   *
   * One stream carrying both, because the sidecar reads them in one pass: the question mirror rides
   * the composer's poll, and asking for them separately would double the Accessibility traffic for a
   * window that is walked once either way.
   *
   * Reaching the sidecar rather than the host lane is the point of ADR-0110. The capability bound did
   * not go away -- the sidecar resolves the window and the standalone helper is the only thing
   * holding `AXUIElement` -- but a change to a poll interval or a failure sentence stopped costing a
   * host build and a re-attach of every surface.
   */
  subscribeWindowComposer(
    session: { source: string; sessionId: string },
    handlers: {
      onComposer?: (status: WindowComposerStatus) => void;
      onQuestion?: (status: WindowQuestionStatus) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(
      `/api/window/composer/stream?source=${encodeURIComponent(session.source)}`
        + `&sessionId=${encodeURIComponent(session.sessionId)}`,
      {
        onMessage: (payload) => {
          try {
            const envelope = JSON.parse(payload) as WindowComposerEnvelope & {
              error?: { message?: string };
            };
            if (envelope.error) {
              handlers.onError?.(envelope.error.message ?? "Composer stream failed");
              return;
            }
            if (envelope.composer) handlers.onComposer?.(envelope.composer);
            if (envelope.question) handlers.onQuestion?.(envelope.question);
          } catch {
            handlers.onError?.("Composer stream returned malformed JSON");
          }
        },
        onError: (reason) => handlers.onError?.(reason),
      },
    );
  }

  /** Fills the composer without committing it. Returns what the field reads back. */
  async syncWindowComposer(
    session: { source: string; sessionId: string },
    text: string,
  ): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request("POST", "/api/window/composer/sync", {
        body: { ...session, text },
      }),
    ).text;
  }

  /** Fills the composer and presses Return. This one deliberately fronts the Claude window. */
  async submitWindowComposer(
    session: { source: string; sessionId: string },
    text: string,
  ): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request("POST", "/api/window/composer/submit", {
        body: { ...session, text },
      }),
    ).text;
  }

  /**
   * Reads the composer, moving the window here if that is what it takes.
   *
   * A POST rather than a GET despite reading nothing but the composer: it can move a window between
   * Desktops, which is a side effect the user asked for explicitly and not something a retry or a
   * prefetch should be free to do.
   */
  async readWindowComposer(session: { source: string; sessionId: string }): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request("POST", "/api/window/composer/read", { body: session }),
    ).text;
  }

  /** One AskUserQuestion interaction, answered with the panel's post-action state. */
  async actOnWindowQuestion(
    sessionId: string,
    action: WindowQuestionAction,
  ): Promise<WindowQuestionStatus> {
    return parse<WindowQuestionStatus>(
      await this.transport.request("POST", "/api/window/question/action", {
        body: { sessionId, ...action },
      }),
    );
  }

  // ---------------------------------------------------------------------
  // The session's own terminal: its inbox, and its tmux composer
  // ---------------------------------------------------------------------

  /**
   * Whether a Claude session is running as a terminal CLI process, and in which tmux pane.
   *
   * Read rather than derived from `capabilities`, because it is a fact about a PROCESS and the
   * capabilities describe a session. A CLI session's row looks identical whether its terminal is
   * open or was closed an hour ago; only the harness's live registry knows the difference.
   */
  async cliSessionStatus(session: SessionAddress): Promise<CliSessionStatus> {
    return parse<CliSessionStatus>(
      await this.transport.request("GET", cliSessionPath(session)),
    );
  }

  /**
   * What the session's own terminal composer holds, and again whenever it changes.
   *
   * A stream rather than a read, and there is deliberately no read form. The composer changes
   * when somebody types, which is an event the pane already publishes; asking on a timer instead
   * cost a `capture-pane` a second for as long as a session was open, and answered "the same as
   * last time" nearly every time. The sidecar reports only differences, so an idle session -- the
   * state a composer spends nearly all its life in -- costs nothing at all.
   *
   * Returns unsubscribe, and the caller must call it.
   */
  subscribeTmuxComposer(
    session: SessionAddress,
    handlers: {
      onComposer?: (state: TmuxComposerState) => void;
      /** The dialog standing in the pane, or null when it has gone. */
      onQuestion?: (state: TmuxQuestionState | null) => void;
      /** The permission mode the pane's footer names, sent only when the footer could be read. */
      onPermissionMode?: (mode: ClaudePermissionMode) => void;
    },
  ): () => void {
    return this.transport.subscribe(tmuxComposerPath(session, "/stream"), {
      onMessage: (payload) => {
        const envelope = JSON.parse(payload) as TmuxComposerEnvelope;
        // Only what the message carries. A field left out says nothing, where `question: null` is
        // the statement that the dialog has gone -- which is what closes the mirror's follow.
        if (envelope.composer) handlers.onComposer?.(envelope.composer);
        if (envelope.question !== undefined) handlers.onQuestion?.(envelope.question);
        if (envelope.permissionMode) handlers.onPermissionMode?.(envelope.permissionMode);
      },
      // Silent by design: the panel already surfaces a sidecar that has stopped answering, and an
      // `EventSource` reconnects on its own. A session that had no pane when this was opened is
      // also the commonest reason to be here, and it is not a fault.
      onError: () => {},
    });
  }

  /**
   * Asks for the session's terminal composer to read `text`.
   *
   * The whole desired text, never the keystrokes: only the sidecar can see what the box currently
   * holds, and it reads it in the same breath as it writes. A delta computed here would be
   * computed against an observation that has already made a round trip, and the person at that
   * keyboard is typing too.
   */
  async syncTmuxComposer(session: SessionAddress, text: string): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session), { body: { text } }),
    );
  }

  /** Presses Return in the session's pane, which is what makes it take the turn. */
  async submitTmuxComposer(session: SessionAddress): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/submit")),
    );
  }

  /**
   * Presses Tab, which is how Claude's own suggestion becomes text in its box.
   *
   * A key rather than a push of the hint's words, because what accepting a suggestion means
   * belongs to Claude. What the box then holds arrives on the stream like any other change.
   */
  async acceptTmuxComposerHint(session: SessionAddress): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/accept")),
    );
  }

  /**
   * Presses one key rail key in the session's prompt box.
   *
   * The key goes over NAMED, not as the bytes it means. The sidecar owns the mapping because it is
   * the side writing into the pane, and both sides read it from the same module on the wire, so a
   * key cannot come to mean one thing here and another there.
   *
   * Nothing comes back but the reason: an arrow moves a cursor and Escape may clear the box, and
   * what the composer holds after either arrives on the stream like every other change.
   */
  async pressTmuxComposerKey(
    session: SessionAddress,
    key: RailKey,
    modifiers: RailModifiers,
  ): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/key"), {
        body: { key, modifiers } satisfies ComposerKeyPress,
      }),
    );
  }

  /**
   * Moves a terminal session to one permission mode: the sidecar presses Shift+Tab until the pane's
   * footer names it, and answers where the footer says it ended up.
   */
  async setTmuxPermissionMode(session: SessionAddress, mode: ClaudePermissionMode): Promise<TmuxPermissionModeOutcome> {
    return parse<TmuxPermissionModeOutcome>(
      await this.transport.request("POST", tmuxComposerPath(session, "/mode"), {
        body: { mode } satisfies TmuxPermissionModeRequest,
      }),
    );
  }

  /**
   * Hands one image to the session's composer.
   *
   * The bytes go over, never a path, and none comes back. The sidecar that answers this is the
   * process on the machine the pane is on -- which may not be this one, and need not be a Mac at
   * all from the panel's side -- so it is the only party that can write a file that pane's Claude
   * can read. A drop is therefore a transfer, not a reference.
   *
   * Base64 because the transport is JSON on both arms: in the webview it is a relay of text
   * frames, so binary would be encoded there regardless.
   */
  async dropTmuxComposerImage(session: SessionAddress, image: Blob): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/image"), {
        body: { data: await base64FromBlob(image) } satisfies ComposerImageDrop,
      }),
    );
  }

  /**
   * The words behind one `[Pasted text #N]` handle, or null when nobody on this side holds them.
   *
   * Fetched rather than carried on the stream, and that is why it is a request at all. A reading
   * goes out on every redraw of the box; a paste runs to the composer's 16 KiB ceiling and does
   * not change once it is made, so carrying it on each reading would pay for a preview on every
   * keystroke whether or not anybody ever opened one.
   *
   * Null is an answer rather than a failure: Claude keeps the text of a paste made AT THAT
   * KEYBOARD inside its own process, so the sidecar can only produce the ones it pasted itself.
   */
  async readTmuxComposerPaste(session: SessionAddress, token: string): Promise<string | null> {
    const answer = await parse<{ text: string | null }>(
      await this.transport.request(
        "GET",
        tmuxComposerPath(session, `/paste/${encodeURIComponent(token)}`),
      ),
    );
    return typeof answer.text === "string" ? answer.text : null;
  }

  /**
   * Answers the AskUserQuestion dialog standing in the session's pane.
   *
   * Every question in one request, not a press at a time. The dialog submits all of them together
   * and a digit on it cannot be taken back, so a half-finished sequence has no owner -- and the
   * free text a reader typed would be somewhere neither side could recover it from. Sending the
   * whole set means a refusal comes back carrying that text, which is the point of the shape.
   */
  async answerTmuxQuestion(
    session: SessionAddress,
    answers: readonly TmuxQuestionAnswer[],
  ): Promise<TmuxQuestionOutcome> {
    return parse<TmuxQuestionOutcome>(
      await this.transport.request(
        "POST",
        `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/question`,
        { body: { answers } },
      ),
    );
  }

  /**
   * Moves the cursor in that dialog onto one option, without answering it.
   *
   * The other direction of the live mirror, and the one call here that is allowed to fail
   * quietly. Everything else this class does is something a reader asked for; this is the panel
   * keeping the terminal's highlight alongside its own, so a refusal means the two are briefly
   * out of step rather than that anything was lost. The sidecar is what enforces that only arrows
   * are pressed to do it -- a digit would answer the question instead of pointing at it.
   */
  async pointTmuxQuestion(
    session: SessionAddress,
    point: TmuxQuestionPoint,
  ): Promise<TmuxQuestionPointOutcome> {
    return parse<TmuxQuestionPointOutcome>(
      await this.transport.request(
        "POST",
        `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/question/point`,
        { body: point },
      ),
    );
  }

  // ---------------------------------------------------------------------
  // A Claude session run through the Agent SDK (ADR-0143)

  /**
   * The runner's state, whole, on every change: its status, mode, and every question and approval
   * it is holding. `connected: false` while no runner answers, which is the state before one
   * starts and after it ends. Returns unsubscribe, and the caller must call it.
   */
  subscribeClaudeSdk(session: SessionAddress, onState: (state: ClaudeSdkSessionState) => void): () => void {
    return this.transport.subscribe(claudeSdkPath(session, "stream"), {
      onMessage: (payload) => onState(JSON.parse(payload) as ClaudeSdkSessionState),
      // Silent for the reason the tmux stream is: `EventSource` reconnects on its own, and the
      // panel already shows a sidecar that has stopped answering.
      onError: () => {},
    });
  }

  /** A turn, with the images that ride it in the shape an opencode send takes them. */
  async promptClaudeSdk(
    session: SessionAddress,
    text: string,
    files?: readonly { data: string; mime: string; name: string }[],
  ): Promise<ClaudeSdkCommandOutcome> {
    return parse<ClaudeSdkCommandOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "prompt"), {
        body: { text, ...(files && files.length > 0 ? { files } : {}) },
      }),
    );
  }

  /** Every answer of one call at once, in the terminal dialog's shape and with its outcome. */
  async answerClaudeSdkQuestion(
    session: SessionAddress,
    answers: readonly TmuxQuestionAnswer[],
  ): Promise<TmuxQuestionOutcome> {
    return parse<TmuxQuestionOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "answer"), { body: { answers } }),
    );
  }

  async decideClaudeSdk(session: SessionAddress, decision: ClaudeSdkDecideCommand): Promise<ClaudeSdkCommandOutcome> {
    return parse<ClaudeSdkCommandOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "decide"), { body: decision }),
    );
  }

  async setClaudeSdkMode(session: SessionAddress, mode: ClaudePermissionMode): Promise<ClaudeSdkCommandOutcome> {
    return parse<ClaudeSdkCommandOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "mode"), { body: { mode } }),
    );
  }

  /** Switches the model the session answers with, from its next turn. */
  async setClaudeSdkModel(session: SessionAddress, model: string): Promise<ClaudeSdkCommandOutcome> {
    return parse<ClaudeSdkCommandOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "model"), { body: { model } }),
    );
  }

  async interruptClaudeSdk(session: SessionAddress): Promise<ClaudeSdkCommandOutcome> {
    return parse<ClaudeSdkCommandOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "interrupt"), { body: {} }),
    );
  }

  /**
   * Moves a running, idle session between the terminal and the SDK runner. The sidecar refuses
   * rather than forces -- a turn running, a request waiting, two processes already -- and says why.
   */
  async switchClaudeRunMode(session: SessionAddress, mode: ClaudeRunMode): Promise<ClaudeSdkSwitchOutcome> {
    return parse<ClaudeSdkSwitchOutcome>(
      await this.transport.request("POST", claudeSdkPath(session, "switch"), { body: { mode } }),
    );
  }
}
