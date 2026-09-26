/**
 * The in-field button is one button with two jobs: Send while idle, Stop while running.
 *
 * No separate stop beside it, because two buttons for one slot is how a reader presses Stop
 * and watches Send stay where it was. The key and placement never change across the swap,
 * which is what makes it the same button rather than a replacement.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { composerActions, submitComposer } from "@/features/session-view/composer/sessionComposerActions";
import { useSendAttachments } from "@/features/session-view/composer/useSendAttachments";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";

function model(overrides: Partial<ComposerModel> = {}): ComposerModel {
  return {
    capabilities: {
      modes: ["nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: false,
      canStreamLive: false,
    },
    deliveryPending: false,
    editorValue: "hello",
    session: { source: "pi", sessionId: "p1" },
    pending: false,
    running: false,
    ...overrides,
  } as ComposerModel;
}

describe("the in-field send button", () => {
  it("sends while idle", () => {
    const actions = composerActions(model({ running: false }));
    const send = actions.find((action) => action.key === "send");
    expect(send?.ariaLabel).toBe("Send message");
    expect(send?.placement).toBe("field");
    expect(actions.some((action) => action.key === "abort")).toBe(false);
  });

  it("is the same button, stopping, while running", () => {
    const actions = composerActions(model({ running: true }));
    const stop = actions.find((action) => action.key === "send");
    expect(stop?.ariaLabel).toBe("Stop agent");
    expect(stop?.placement).toBe("field");
    expect(stop?.disabled).toBe(false);
    expect(actions.some((action) => action.key === "abort")).toBe(false);
  });

  it("stays a queueing send while running where nothing can abort", () => {
    const actions = composerActions(model({
      running: true,
      capabilities: {
        modes: ["nice"],
        canSend: true,
        canSteer: false,
        canAbort: false,
        canFetchRaw: false,
        canOpenTerminal: false,
        supportsExtensionUi: false,
        canStreamLive: false,
      },
    }));
    expect(actions.find((action) => action.key === "send")?.ariaLabel).toBe("Queue message");
  });
});

describe("sending with held images", () => {
  it("reads opencode attachments onto the send and clears them after", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:1"),
      revokeObjectURL: vi.fn(),
    });
    try {
      const { result } = renderHook(() => useSendAttachments("opencode/s1"));
      await act(async () => {
        result.current.attach([new File(["bytes"], "shot.png", { type: "image/png" })]);
      });
      const onSendMessage = vi.fn(async () => {});
      const setLocalDraft = vi.fn();
      const m = model({
        editorValue: "look",
        session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
        sendAttachments: result.current,
        onSendMessage,
        setLocalDraft,
      } as Partial<ComposerModel>);
      await act(async () => {
        await submitComposer(m, "next");
      });
      expect(onSendMessage).toHaveBeenCalledWith("look", "next", [
        { data: "Ynl0ZXM=", mime: "image/png", name: "shot.png" },
      ]);
      expect(setLocalDraft).toHaveBeenCalledWith("");
      expect(result.current.images).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends text alone where no images are held", async () => {
    const onSendMessage = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const m = model({
      editorValue: "plain",
      session: { source: "pi", sessionId: "p1" } as ComposerModel["session"],
      sendAttachments: result.current,
      onSendMessage,
      setLocalDraft: vi.fn(),
    } as Partial<ComposerModel>);
    await act(async () => {
      await submitComposer(m, "next");
    });
    expect(onSendMessage).toHaveBeenCalledWith("plain", "next", undefined);
  });
});

describe("the model switcher", () => {
  it("shows the session model and opens the picker", () => {
    const onOpenModels = vi.fn();
    const actions = composerActions(model({
      session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
      sessionModel: "opencode-go/muse-spark",
      onOpenModels,
    }));
    const button = actions.find((action) => action.key === "switch-model");
    expect(button?.placement).toBe("footer");
    button?.onClick();
    expect(onOpenModels).toHaveBeenCalledWith("");
  });

  it("is absent off opencode", () => {
    const actions = composerActions(model({
      session: { source: "pi", sessionId: "p1" } as ComposerModel["session"],
    }));
    expect(actions.some((action) => action.key === "switch-model")).toBe(false);
  });
});

describe("sending a slash command", () => {
  it("runs a listed command natively with the remainder as arguments", async () => {
    const onRunCommand = vi.fn(async () => {});
    const onSendMessage = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const setLocalDraft = vi.fn();
    const m = model({
      editorValue: "/review the last commit",
      session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
      sendAttachments: result.current,
      opencodeCommands: [{ name: "review", description: "review changes" }],
      onRunCommand,
      onSendMessage,
      setLocalDraft,
    } as Partial<ComposerModel>);
    await act(async () => {
      await submitComposer(m, "next");
    });
    expect(onRunCommand).toHaveBeenCalledWith("review", "the last commit");
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(setLocalDraft).toHaveBeenCalledWith("");
  });

  it("sends an unknown slash as text, which the serve reads literally", async () => {
    const onRunCommand = vi.fn(async () => {});
    const onSendMessage = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const m = model({
      editorValue: "/nope nothing",
      session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
      sendAttachments: result.current,
      opencodeCommands: [{ name: "review" }],
      onRunCommand,
      onSendMessage,
      setLocalDraft: vi.fn(),
    } as Partial<ComposerModel>);
    await act(async () => {
      await submitComposer(m, "next");
    });
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(onSendMessage).toHaveBeenCalledWith("/nope nothing", "next", undefined);
  });

  it("opens the model picker for /models instead of running anything", async () => {
    const onOpenModels = vi.fn();
    const onRunCommand = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const m = model({
      editorValue: "/models spark",
      session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
      sendAttachments: result.current,
      opencodeCommands: [],
      onRunCommand,
      onOpenModels,
      onSendMessage: vi.fn(async () => {}),
      setLocalDraft: vi.fn(),
    } as Partial<ComposerModel>);
    await act(async () => {
      await submitComposer(m, "next");
    });
    expect(onOpenModels).toHaveBeenCalledWith("spark");
    expect(onRunCommand).not.toHaveBeenCalled();
  });
});
