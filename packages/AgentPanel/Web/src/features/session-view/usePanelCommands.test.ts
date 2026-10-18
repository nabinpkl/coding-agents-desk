/**
 * Which slash command ends where, and what the reader is told when it cannot.
 *
 * The routing is the thing under test, not the fetches: `/model` opens a dialog, `/new` and
 * `/fork` make a session the surface has to place, `/export` writes a file, `/btw` asks and
 * shows, and everything else is the sidecar's. A wrong arm here is a command that either did
 * nothing or did something the reader did not ask for, which is the failure a list of names
 * cannot show.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePanelCommands } from "@/features/session-view/usePanelCommands";

function setup(overrides: Partial<Parameters<typeof usePanelCommands>[0]> = {}) {
  const runCommand = vi.fn(async () => ({ requestId: "r1", delivery: "immediate" as const }));
  const createSession = vi.fn(async (projectPath: string) => ({
    sessionId: "ses_new",
    source: "opencode" as const,
    projectPath,
    title: "Fresh",
    lastEventAt: 1,
    activity: "ready" as const,
    capabilities: {} as never,
  }));
  const reportError = vi.fn();
  const onAttachSession = vi.fn(async () => {});
  const feed = {
    askOpencodeAside: vi.fn(async () => "a side answer"),
    exportOpencodeTranscript: vi.fn(async () => ({ info: { id: "s1" }, messages: [] })),
  };
  const input = {
    commands: {
      runSlashCommand: runCommand,
      createOpencodeSession: createSession,
      switchModel: vi.fn(async () => {}),
      reportCommandError: reportError,
    },
    feed: feed as never,
    sessionId: "s1",
    projectPath: "/repo",
    ...(overrides.onAttachSession === null ? {} : { onAttachSession }),
    ...overrides,
  } as unknown as Parameters<typeof usePanelCommands>[0];
  return { input, runCommand, createSession, reportError, onAttachSession, feed };
}

describe("the panel's own commands", () => {
  it("opens the model picker with whatever filter the draft carried", async () => {
    const { result } = renderHook(() => usePanelCommands(setup().input));
    expect(result.current.surfaces.models).toBeNull();
    await act(async () => {
      await result.current.run("model", "opus");
    });
    expect(result.current.surfaces.models?.filter).toBe("opus");
    act(() => result.current.surfaces.models?.onClose());
    expect(result.current.surfaces.models).toBeNull();
  });

  it("hands every other name to the sidecar rather than deciding here", async () => {
    const { input, runCommand } = setup();
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("compact", "");
    });
    expect(runCommand).toHaveBeenCalledWith("compact", "");
    expect(result.current.surfaces.models).toBeNull();
    expect(result.current.surfaces.aside).toBeNull();
  });

  it("starts a session for `/new` and puts it where the card asked", async () => {
    const { input, createSession, onAttachSession } = setup();
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("new", "");
    });
    expect(createSession).toHaveBeenCalledWith("/repo");
    expect(onAttachSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_new" }));
  });

  it("places the session a fork's receipt names", async () => {
    const forked = {
      sessionId: "ses_fork",
      source: "opencode" as const,
      projectPath: "/repo",
      title: "Forked",
      lastEventAt: 1,
      activity: "ready" as const,
      capabilities: {} as never,
    };
    const { input, onAttachSession } = setup({
      commands: {
        runSlashCommand: vi.fn(async () => ({ requestId: "r", delivery: "immediate" as const, session: forked })),
        createOpencodeSession: vi.fn(),
        switchModel: vi.fn(async () => {}),
        reportCommandError: vi.fn(),
      },
    } as never);
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("fork", "");
    });
    expect(onAttachSession).toHaveBeenCalledWith(forked);
  });

  it("says where a made session went when this surface has nowhere to put it", async () => {
    // The command still runs there: a session exists either way, and a command that appears to do
    // nothing is indistinguishable from one that was never asked for.
    const { input, reportError } = setup({ onAttachSession: undefined });
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("new", "");
    });
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("Fresh"));
  });

  it("writes the transcript to a file rather than to the clipboard", async () => {
    const createObjectURL = vi.fn(() => "blob:one");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clicked: { download: string; href: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
    try {
      const { input, feed } = setup();
      const { result } = renderHook(() => usePanelCommands(input));
      await act(async () => {
        await result.current.run("export", "");
      });
      expect(feed.exportOpencodeTranscript).toHaveBeenCalledWith("s1");
      expect(clicked).toEqual([{ download: "opencode-s1.json", href: "blob:one" }]);
      // Left on a tick rather than revoked immediately: Safari has been seen to abort a download
      // whose URL is gone before it starts reading.
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:one"));
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("asks a side question the draft carried, and shows the answer", async () => {
    const { input, feed } = setup();
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("btw", "what did we decide?");
    });
    expect(feed.askOpencodeAside).toHaveBeenCalledWith("s1", "what did we decide?");
    expect(result.current.surfaces.aside).toEqual({
      question: "what did we decide?",
      answer: "a side answer",
      error: null,
      pending: false,
    });
  });

  it("opens the question empty when the draft carried none, rather than refusing", async () => {
    const { input, feed } = setup();
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("btw", "");
    });
    expect(feed.askOpencodeAside).not.toHaveBeenCalled();
    expect(result.current.surfaces.aside).toEqual({ question: "", answer: null, error: null, pending: false });

    await act(async () => {
      result.current.surfaces.onAskAside("and the model?");
    });
    await waitFor(() => expect(result.current.surfaces.aside?.answer).toBe("a side answer"));
  });

  it("keeps a failed aside in the dialog, where the reader is looking", async () => {
    const { input } = setup({
      feed: {
        askOpencodeAside: vi.fn(async () => {
          throw new Error("serve answered 500");
        }),
        exportOpencodeTranscript: vi.fn(),
      } as never,
    });
    const { result } = renderHook(() => usePanelCommands(input));
    await act(async () => {
      await result.current.run("btw", "why");
    });
    expect(result.current.surfaces.aside?.error).toBe("serve answered 500");
    expect(result.current.surfaces.aside?.answer).toBeNull();
  });
});
