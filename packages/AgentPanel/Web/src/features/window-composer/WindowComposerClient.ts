import type { WindowQuestionAction, WindowQuestionStatus } from "@agentdesk/agent-feed-wire";
import { SidecarError, type SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/**
 * Live state of one session's Claude Desktop composer, as the host last resolved it.
 *
 * `reason` stays a plain string rather than a union: the host owns the code list, and a code this
 * build does not recognize has to degrade to "unavailable, reason unknown" rather than break the
 * field. The panel owns the WORDING for the codes it knows.
 */
export interface WindowComposerStatus {
  sessionId: string;
  enabled: boolean;
  reason: string | null;
  /** True when the owning window is already on the active Desktop, so reading costs no Space move. */
  onActiveDesktop: boolean;
  /** The composer's current text, present only when it was read without moving anything. */
  composerText: string | null;
}

/** A composer read or write that the host refused or could not complete. */
export class WindowComposerError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`window composer request failed: ${reason}`);
    this.name = "WindowComposerError";
    this.reason = reason;
  }
}

/**
 * The AskUserQuestion panel's live state in the session's Claude Desktop window, as the host last
 * read it. CONTENT is deliberately absent: the question text, options, and multi-select shape come
 * from the transcript feed's `AskUserQuestion` tool_use, and this only augments it with what a live
 * AX read adds -- selection, the Other input, Submit's enabled state, and presence.
 */
export interface QuestionPanelStatus {
  sessionId: string;
  enabled: boolean;
  reason: string | null;
  /** True when the owning window is already on the active Desktop, so AX reads cost no Space move. */
  onActiveDesktop: boolean;
  /**
   * Whether an AskUserQuestion panel exists in the window's tree. null when the window is on another
   * Desktop, where Chromium builds no tree to read -- the mirror keeps its JSON content either way.
   */
  present: boolean | null;
  /** Indices (into the JSON `options` array) currently selected or checked in the panel. */
  selected: number[];
  /** The panel's "Other" input value, or null when empty or unreadable. */
  otherText: string | null;
  /** The panel's Submit button enabled state, or null when unreadable. */
  submitEnabled: boolean | null;
}

/** A question action the host refused or could not complete. */
export class WindowQuestionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`window question action failed: ${reason}`);
    this.name = "WindowQuestionError";
    this.reason = reason;
  }
}

/**
 * The composer surface the panel's hooks talk to.
 *
 * Both Claude's and Codex's composers are served by the sidecar and the standalone helper now
 * (ADR-0110), so this is one implementation over two sources rather than a seam between two
 * backings. It stays an interface because the hooks are the code under test and a fake is how they
 * are driven.
 *
 * The method names and the status shapes are the retired host client's, deliberately: keeping them
 * meant the hooks did not change at all when what answered them did.
 */
export interface WindowComposerClient {
  subscribeWindowComposer(sessionId: string, listener: (status: WindowComposerStatus) => void): () => void;
  syncWindowComposer(sessionId: string, text: string): Promise<string>;
  readWindowComposer(sessionId: string): Promise<string>;
  submitWindowComposer(sessionId: string, text: string): Promise<string>;
  subscribeWindowQuestion(sessionId: string, listener: (status: QuestionPanelStatus) => void): () => void;
  selectQuestionOption(sessionId: string, option: number, desired: boolean): Promise<QuestionPanelStatus>;
  setQuestionOther(sessionId: string, text: string): Promise<QuestionPanelStatus>;
  submitQuestion(sessionId: string): Promise<QuestionPanelStatus>;
  skipQuestion(sessionId: string): Promise<QuestionPanelStatus>;
  dismissQuestion(sessionId: string): Promise<QuestionPanelStatus>;
  toggleQuestionOptions(sessionId: string): Promise<QuestionPanelStatus>;
}

/**
 * The composer, through the sidecar.
 *
 * The one shape difference between the two backings is the question status: the wire calls the
 * chosen options `selectedIndices` while the host client called them `selected`, and the wire has no
 * `onActiveDesktop` on the question half because the composer half already carries it for the same
 * window. Both are mapped here rather than renamed at either end, so neither the wire contract nor
 * the hooks moved to accommodate a transitional adapter.
 */
export function sidecarWindowComposerClient(feed: SidecarDataSource, source: "claude" | "codex"): WindowComposerClient {
  /**
   * One stream per session, shared by the composer and question watchers.
   *
   * The sidecar reads both halves in one pass and sends them down one stream, so opening a second
   * connection for the question half would cost a second SSE slot and buy nothing. Refcounted:
   * the stream closes when the last of the two watchers goes away, which is what releases the
   * window's editing lease.
   */
  const streams = new Map<
    string,
    {
      composer: Set<(status: WindowComposerStatus) => void>;
      question: Set<(status: QuestionPanelStatus) => void>;
      close: () => void;
    }
  >();

  function share(sessionId: string) {
    const existing = streams.get(sessionId);
    if (existing) return existing;
    const entry = {
      composer: new Set<(status: WindowComposerStatus) => void>(),
      question: new Set<(status: QuestionPanelStatus) => void>(),
      close: () => {},
    };
    streams.set(sessionId, entry);
    entry.close = feed.subscribeWindowComposer(
      { source, sessionId },
      {
        onComposer: (status) => {
          for (const listener of entry.composer) listener(status);
        },
        onQuestion: (status) => {
          const mapped = asPanelStatus(status);
          for (const listener of entry.question) listener(mapped);
        },
      },
    );
    return entry;
  }

  function release(sessionId: string) {
    const entry = streams.get(sessionId);
    if (!entry || entry.composer.size > 0 || entry.question.size > 0) return;
    streams.delete(sessionId);
    entry.close();
  }

  function asPanelStatus(status: WindowQuestionStatus): QuestionPanelStatus {
    return {
      sessionId: status.sessionId,
      enabled: status.enabled,
      reason: status.reason,
      // The composer half of the same envelope carries the real answer for this window; the question
      // half never needed its own copy, and a second source for one fact is how the two disagree.
      onActiveDesktop: status.enabled,
      present: status.enabled ? status.present : null,
      selected: status.selectedIndices,
      otherText: status.otherText,
      submitEnabled: status.submitEnabled,
    };
  }

  /**
   * Turns a sidecar refusal back into the error the hooks already know.
   *
   * The reason code is what matters and it survives: the sidecar puts it in `message`, and the panel
   * maps a code it recognizes to a sentence and everything else to "unavailable, reason unknown".
   */
  function composerFailure(error: unknown): never {
    throw error instanceof SidecarError ? new WindowComposerError(error.message) : error;
  }

  function questionFailure(error: unknown): never {
    throw error instanceof SidecarError ? new WindowQuestionError(error.message) : error;
  }

  async function act(sessionId: string, action: WindowQuestionAction): Promise<QuestionPanelStatus> {
    try {
      return asPanelStatus(await feed.actOnWindowQuestion(sessionId, action));
    } catch (error) {
      return questionFailure(error);
    }
  }

  return {
    subscribeWindowComposer(sessionId, listener) {
      const entry = share(sessionId);
      entry.composer.add(listener);
      return () => {
        entry.composer.delete(listener);
        release(sessionId);
      };
    },
    subscribeWindowQuestion(sessionId, listener) {
      const entry = share(sessionId);
      entry.question.add(listener);
      return () => {
        entry.question.delete(listener);
        release(sessionId);
      };
    },
    async syncWindowComposer(sessionId, text) {
      try {
        return await feed.syncWindowComposer({ source, sessionId }, text);
      } catch (error) {
        return composerFailure(error);
      }
    },
    async readWindowComposer(sessionId) {
      try {
        return await feed.readWindowComposer({ source, sessionId });
      } catch (error) {
        return composerFailure(error);
      }
    },
    async submitWindowComposer(sessionId, text) {
      try {
        return await feed.submitWindowComposer({ source, sessionId }, text);
      } catch (error) {
        return composerFailure(error);
      }
    },
    selectQuestionOption: (sessionId, option, desired) => act(sessionId, { kind: "select", option, desired }),
    setQuestionOther: (sessionId, text) => act(sessionId, { kind: "other", text }),
    submitQuestion: (sessionId) => act(sessionId, { kind: "submit" }),
    skipQuestion: (sessionId) => act(sessionId, { kind: "skip" }),
    dismissQuestion: (sessionId) => act(sessionId, { kind: "dismiss" }),
    toggleQuestionOptions: (sessionId) => act(sessionId, { kind: "view-options" }),
  };
}
