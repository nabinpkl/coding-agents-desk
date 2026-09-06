/**
 * Desktop windows, session targeting, and composer failure codes.
 *
 * One declaration for three readers: the sidecar's resolver, the standalone `grid-encoder --control`
 * helper that answers `desktop-audit` and performs the AX verbs, and the panel that renders the
 * result. The helper writes JSON by hand rather than importing this, so the shapes below are the
 * contract it is written against, not a type it derives.
 */

/**
 * Why a session's composer is unavailable, or why a write did not land.
 *
 * Fixed codes rather than prose: the panel owns the wording, a code survives translation, and it
 * greps cleanly in logs. Carried as a plain string so a code a peer does not recognize degrades to
 * "unavailable, reason unknown" instead of failing the whole message.
 */
export type WindowInputReason =
  /** No process anywhere carries `--resume <sessionId>`, so the session is not open. */
  | "not-running"
  /**
   * A resuming process exists, but every parent chain terminates at a shell or tmux rather than the
   * Claude.app main binary. A terminal session has no window composer to write into.
   */
  | "terminal-only"
  /**
   * Two or more Claude.app instances each hold this session. macOS reaches this state on its own,
   * and each instance has its own window on its own Desktop. Reported rather than resolved: picking
   * one silently addresses the wrong window, and the write looks successful right up until the text
   * appears in the other Desktop's session.
   */
  | "multiple-instances"
  /** The chain reaches Claude.app, but WindowServer lists no window for that pid. */
  | "no-window"
  | "ax-denied"
  /**
   * The window materialized but exposed no `AXTextArea` described as `Prompt`. Deliberately fatal:
   * writing into whatever text element happened to be first is worse than refusing.
   */
  | "composer-missing"
  /** A window could not be brought to the active Desktop, so nothing was attempted in it. */
  | "move-failed"
  /**
   * A window was brought here, acted on, and could not be sent back. Distinct from `move-failed`
   * because the user's workspace is now visibly wrong -- the window is sitting on the Desktop they
   * are looking at -- and because whatever was asked for probably DID happen. Telling them the
   * window "could not be brought here" while it stares at them from this Desktop is the one wording
   * that makes the state impossible to reason about.
   */
  | "restore-failed"
  /**
   * This macOS build does not expose the private bridged operation for moving another application's
   * window between Desktops. Separate from `move-failed` because retrying cannot restore a native
   * capability that is not there.
   */
  | "window-mover-unavailable"
  /** Screen Recording is not granted to the helper, so no window can be captured. */
  | "capture-denied"
  | "write-failed"
  /** The composer read back as something other than what was written. */
  | "verify-mismatch"
  /** The Space authority could not resolve Desktops, so no move can be attempted or verified. */
  | "placement-unavailable"
  /**
   * The frontmost application changed across the write. The write is non-activating by
   * construction, so this reports a broken assumption rather than a recoverable failure.
   */
  | "focus-stolen"
  /** A Codex Desktop session resolved to more than one open window. Refused rather than guessed. */
  | "ambiguous-window"
  /** A question action found no AskUserQuestion panel in the window. */
  | "question-missing"
  /** The helper is not built, not trusted, or did not answer. */
  | "helper-unavailable";

/** One user Desktop, as the helper's `desktop-audit` reports it. */
export interface DesktopSpace {
  /**
   * Space `id64`: monotonic, never reused, and NOT the "Desktop N" ordinal Mission Control shows.
   * A string on the wire because it is a uint64 and JSON numbers are doubles, so an id past 2^53
   * would quietly round. Nothing compares these numerically.
   */
  id: string;
  displayID: string;
  /** Position among that display's Desktops. */
  ordinal: number;
  /** Position across every display, in Mission Control's order. */
  missionControlOrdinal: number;
  isActive: boolean;
}

export interface DesktopWindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One WindowServer window. */
export interface DesktopWindow {
  windowID: number;
  ownerPID: number;
  ownerName: string;
  /**
   * Empty unless the reader holds Screen Recording. That is not a detail: targeting skips Electron's
   * untitled scaffolding windows by this field, so a process without the grant sees every window as
   * untitled and confidently resolves to nothing. `DesktopAuditSnapshot.screenRecordingTrusted` is
   * what distinguishes that from a desktop that genuinely has no titled windows.
   */
  title: string;
  /** Space membership. Empty for a window belonging to no managed Space. */
  spaceIDs: string[];
  /** Window level. 0 is an ordinary application window; panels and shadows sit above. */
  layer: number;
  bounds: DesktopWindowBounds;
}

export interface DesktopAuditSnapshot {
  activeSpaceID: string | null;
  desktops: DesktopSpace[];
  windows: DesktopWindow[];
  /** Non-null when the SkyLight binding could not answer. Never a silently empty snapshot. */
  diagnostic: string | null;
  screenRecordingTrusted: boolean;
}

/** A Claude Desktop window that owns a session, located on the Desktop it currently sits on. */
export interface WindowTarget {
  sessionId: string;
  claudeMainPid: number;
  windowID: number;
  homeSpaceID: string;
  activeSpaceID: string;
  /**
   * WindowServer's bounds. Carried because Accessibility has no notion of a `CGWindowID`:
   * correlating the audited window to its `AXUIElement` is a frame match against the same process's
   * AX windows.
   */
  bounds: DesktopWindowBounds;
  /** True when no Space move is needed to read or write the composer. */
  onActiveDesktop: boolean;
}

/** Either the window to act on, or why there is not exactly one. */
export type WindowResolution =
  | { ok: true; target: WindowTarget }
  | { ok: false; reason: WindowInputReason };

/** Live state of one session's Claude Desktop composer, as the sidecar last resolved it. */
export interface WindowComposerStatus {
  sessionId: string;
  enabled: boolean;
  /**
   * Why it is unavailable, or null. A plain string rather than the union on the wire: the sidecar
   * owns the code list, and a code this build does not recognize has to degrade to "unavailable,
   * reason unknown" rather than break the field. The panel owns the WORDING for codes it knows.
   */
  reason: string | null;
  /** True when the owning window is already on the active Desktop, so reading costs no Space move. */
  onActiveDesktop: boolean;
  /** The composer's current text, present only when it was read without moving anything. */
  composerText: string | null;
}

/**
 * The AskUserQuestion panel's live state.
 *
 * CONTENT is deliberately absent: the question text, options, and multi-select shape come from the
 * transcript feed's `AskUserQuestion` tool_use, and this only augments it with what a live read adds
 * -- selection, the Other input, Submit's enabled state, and presence.
 */
export interface WindowQuestionStatus {
  sessionId: string;
  enabled: boolean;
  reason: string | null;
  present: boolean;
  /** Indices into the JSON `options` array that are currently selected or checked. */
  selectedIndices: number[];
  otherText: string | null;
  submitEnabled: boolean | null;
}

/** One frame of the composer stream. Both halves ride one stream because they share one poll pass. */
export interface WindowComposerEnvelope {
  composer?: WindowComposerStatus;
  question?: WindowQuestionStatus;
}

/** One interaction against the AskUserQuestion panel in a Claude Desktop window. */
export type WindowQuestionAction =
  | { kind: "select"; option: number; desired: boolean }
  | { kind: "other"; text: string }
  | { kind: "submit" | "skip" | "dismiss" | "view-options" };
