// The session modal kept current with its session for as long as it is open.
//
// The modal is handed the row it opened with, and a row is a snapshot: a session renamed while its
// window was open -- by `/rename` in its own composer, by its harness naming it after a turn, from
// another device -- kept its old name there until the window was reopened. So this hands the
// modal the live row instead: the Bot's record when a Bot holds the session (the Bot stream carries
// every machine's), else the row in a directory list the panel already follows, else its directory
// read on its own machine while the window is open.
//
// The session view keys its work on the session's id, so a fresh row on every update re-renders it
// and reopens nothing; a Bot's card hands it a fresh row on every Bot-stream push the same way.

import type { ComponentProps } from "react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { BotMachine } from "@/features/bots/botMachines";
import { useMachineInventory } from "@/features/bots/useMachineInventory";
import { SessionModal } from "@/features/session-view/modal/SessionModal";

const NO_PATHS: readonly string[] = [];

const keyOf = (session: { source: string; sessionId: string }) => `${session.source}:${session.sessionId}`;

/** A row with no name of its own is titled with its session's id (`sessionTitle` in the sidecar). */
const unnamed = (session: SessionSummary) => !session.title || session.title === session.sessionId;

export function LiveSessionModal({
  bots,
  sessionsByProject,
  machine,
  ...modal
}: ComponentProps<typeof SessionModal> & {
  /** Every Bot the panel holds. One that holds this session has its live record. */
  bots: readonly BotView[];
  /** The directory lists the panel already follows, on any machine, by path. */
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  /** The machine the session is on, whose directory is read when nothing above lists it. */
  machine: BotMachine;
}) {
  const key = keyOf(modal.session);
  const path = modal.project.projectPath;
  const held = bots.flatMap((bot) => bot.sessions).find((each) => keyOf(each) === key);
  // By the session's key rather than the path alone: two machines can both have `/tmp`, and only one
  // of them lists this session.
  const listed = held ?? sessionsByProject.get(path)?.find((each) => keyOf(each) === key);
  const read = useMachineInventory(listed ? null : machine, listed ? NO_PATHS : [path]);
  const live = listed ?? read.sessionsByProject.get(path)?.find((each) => keyOf(each) === key) ?? modal.session;
  // A session just started is handed over under the name it was started with, and the catalog can
  // list it a moment before that name is applied; the row with none does not take the name away.
  const shown = unnamed(live) && !unnamed(modal.session) ? { ...live, title: modal.session.title } : live;
  return <SessionModal {...modal} session={shown} />;
}
