// The slash commands the panel runs itself, rather than handing to the sidecar.
//
// Five of opencode's web-client commands do not end at a turn: `/model` opens a dialog over the
// composer, `/new` and `/fork` make a session the surface then has to place, `/export` writes a
// file, and `/btw` asks a question of the session's own context and shows the answer. The rest
// -- compact, undo, redo, rename, and every custom command the serve carries -- go straight to
// the sidecar, which is why the default arm of `run` is that call and not an error.
//
// The routing lives here rather than in the composer so one door answers "what does this name
// mean": the composer parses the draft into a name and arguments and asks, and nothing below it
// knows which commands the panel owns.

import { useCallback, useState } from "react";
import type { AgentSessionDescriptor } from "@agentdesk/agent-feed-wire";
import type { OpencodeModelsMenu } from "@/features/bots/dialogs/OpencodeModelsDialog";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { useSessionCommands } from "@/features/session-view/useSessionCommands";

/** A `/btw` question and its answer, or a question still being typed. */
export interface OpencodeAside {
  question: string;
  answer: string | null;
  error: string | null;
  pending: boolean;
}

/**
 * What a command left open over the composer, and the one way to answer it.
 *
 * One object because the band draws them in one place and neither is the other's business: the
 * model picker rises from the footer's model switcher, and the aside from the same edge, and a
 * reader who typed `/btw` should not have had the picker in the way first.
 */
export interface PanelCommandSurfaces {
  models: OpencodeModelsMenu | null;
  aside: OpencodeAside | null;
  onAskAside: (question: string) => void;
  onCloseAside: () => void;
}

export function usePanelCommands(input: {
  /** The session's commands, which own the pending flag and the caption every failure lands in. */
  commands: Pick<
    ReturnType<typeof useSessionCommands>,
    "runSlashCommand" | "createOpencodeSession" | "switchModel" | "reportCommandError"
  >;
  feed: SidecarDataSource;
  sessionId: string;
  /** The session's own directory, which is where a `/new` session is created. */
  projectPath: string;
  /**
   * Attaches a session this command made to the Bot whose card asked, and opens its card.
   *
   * Absent on a surface with nowhere to put one -- the shell's own thread view, which reads a
   * session with no canvas behind it -- and then the command still runs and says so, rather than
   * pretending to have done nothing.
   */
  onAttachSession?: (session: AgentSessionDescriptor) => void | Promise<void>;
}): {
  run: (name: string, args: string) => Promise<void>;
  surfaces: PanelCommandSurfaces;
} {
  const { commands, feed, sessionId, projectPath, onAttachSession } = input;
  const { runSlashCommand, createOpencodeSession, switchModel, reportCommandError } = commands;
  const [modelsFilter, setModelsFilter] = useState<string | null>(null);
  const [aside, setAside] = useState<OpencodeAside | null>(null);

  const place = useCallback(
    async (session: AgentSessionDescriptor, verb: string) => {
      if (!onAttachSession) {
        // The session exists either way. Saying so is the whole difference between a command that
        // worked and one that appears broken.
        reportCommandError(`${verb} ${session.title || session.sessionId}; this surface has nowhere to open it.`);
        return;
      }
      await onAttachSession(session);
    },
    [onAttachSession, reportCommandError],
  );

  const askAside = useCallback(
    async (question: string) => {
      const asked = question.trim();
      if (!asked) return;
      setAside({ question: asked, answer: null, error: null, pending: true });
      try {
        const text = await feed.askOpencodeAside(sessionId, asked);
        setAside({ question: asked, answer: text, error: null, pending: false });
      } catch (failure) {
        // In the dialog rather than the caption: the caption is under the composer, which this
        // command just covered with the thing the reader is looking at.
        setAside({ question: asked, answer: null, error: String((failure as Error).message ?? failure), pending: false });
      }
    },
    [feed, sessionId],
  );

  const run = useCallback(
    async (name: string, args: string) => {
      if (name === "model") {
        setModelsFilter(args);
        return;
      }
      if (name === "new") {
        await place(await createOpencodeSession(projectPath), "Started");
        return;
      }
      if (name === "fork") {
        const receipt = await runSlashCommand("fork", args);
        // The serve made the session; the receipt is what names it. No session in the receipt
        // means the fork did not happen, which the sidecar would have refused rather than
        // answered, so there is nothing to place and nothing to say.
        if (receipt.session) await place(receipt.session, "Forked");
        return;
      }
      if (name === "export") {
        const transcript = await feed.exportOpencodeTranscript(sessionId);
        downloadTranscript(sessionId, transcript);
        return;
      }
      if (name === "btw") {
        // With a question in the draft it is asked at once; without one the dialog asks, which is
        // what the TUI does when the command arrives with no argument.
        if (args.trim()) await askAside(args);
        else setAside({ question: "", answer: null, error: null, pending: false });
        return;
      }
      await runSlashCommand(name, args);
    },
    [askAside, createOpencodeSession, feed, place, runSlashCommand, sessionId],
  );

  return {
    run,
    surfaces: {
      models: modelsFilter === null
        ? null
        : { filter: modelsFilter, onClose: () => setModelsFilter(null), onSwitch: switchModel },
      aside,
      onAskAside: (question: string) => void askAside(question),
      onCloseAside: () => setAside(null),
    },
  };
}

/**
 * Writes the transcript to a file the way the web client's `/export` does.
 *
 * A download rather than a copy, because a whole transcript is not something to put on a
 * clipboard by surprise. The object URL is revoked on the next tick rather than immediately:
 * Safari has been seen to abort a download whose URL is gone before it starts reading.
 */
function downloadTranscript(sessionId: string, transcript: unknown): void {
  const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `opencode-${sessionId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
