// The shell's own commands at a session: sending, running a slash command, stopping.
//
// One pending flag and one error across all three, because from the reader's side they are one
// slot: the composer button morphs between Send and Stop, and a second command while one is in
// flight waits rather than overlapping. Each failure names itself in the caption and keeps the
// draft, so nothing typed is lost to a refusal.

import { useCallback, useState } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";

export function useSessionCommands(
  feed: SidecarDataSource,
  session: SessionSummary,
) {
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const sendPrompt = useCallback(async (
    text: string,
    delivery: "next" | "steer",
    files?: { data: string; mime: string; name: string }[],
  ) => {
    if (commandPending || !text.trim()) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.sendMessage(session, text.trim(), delivery, files);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
      // Rethrow so the composer that owns the draft only clears it on success.
      throw error;
    } finally {
      setCommandPending(false);
    }
  }, [commandPending, feed, session]);

  /**
   * Runs a slash command natively on an opencode session, with the draft's remainder as its
   * arguments. Same pending and error contract as a send, because from the reader's side it
   * is one: type after a slash, press Return, watch it run.
   */
  const runSlashCommand = useCallback(async (name: string, args: string) => {
    if (commandPending) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.runOpencodeCommand(session.sessionId, name, args);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
      throw error;
    } finally {
      setCommandPending(false);
    }
  }, [commandPending, feed, session]);

  const abortRun = useCallback(async () => {
    if (commandPending) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.abortSession(session);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
    } finally {
      setCommandPending(false);
    }
  }, [commandPending, feed, session]);

  /**
   * Answers an extension UI request. Outside the pending flag on purpose: a question answered
   * while a turn runs must not wait behind it, and answering never starts a turn of its own.
   * The error still lands in the same caption, because from the reader's side it is the same
   * composer failing. Draft-safe like the rest: the failure is rethrown.
   */
  const respondToExtensionUI = useCallback(async (requestId: string, value: unknown) => {
    setCommandError(null);
    try {
      await feed.respondToExtensionUI(session, requestId, value);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
      throw error;
    }
  }, [feed, session]);

  /**
   * Switches an opencode session's model. Same pending and error contract as a send: the
   * change lands on the session event, which is what moves the meter without a second read.
   */
  const switchModel = useCallback(async (providerID: string, modelID: string) => {
    if (commandPending) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.switchOpencodeModel(session.sessionId, providerID, modelID);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
      throw error;
    } finally {
      setCommandPending(false);
    }
  }, [commandPending, feed, session]);

  return { commandPending, commandError, sendPrompt, runSlashCommand, abortRun, respondToExtensionUI, switchModel };
}
