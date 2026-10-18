/**
 * The in-field button is one button with two jobs: Send while idle, Stop while running.
 *
 * No separate stop beside it, because two buttons for one slot is how a reader presses Stop
 * and watches Send stay where it was. The key and placement never change across the swap,
 * which is what makes it the same button rather than a replacement.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { composerActions } from "@/features/session-view/composer/sessionComposerActions";
import { compactControl, submitComposer } from "@/features/session-view/composer/sessionComposerSubmit";
import { useSendAttachments } from "@/features/session-view/composer/hold/useComposerHold";
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
    const actions = composerActions(
      model({
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
      }),
    );
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
  it("shows the session model and opens the picker through the same door `/model` uses", () => {
    const onRunSlash = vi.fn(async () => {});
    const actions = composerActions(
      model({
        session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
        sessionModel: "opencode-go/muse-spark",
        onRunSlash,
      }),
    );
    const button = actions.find((action) => action.key === "switch-model");
    expect(button?.placement).toBe("footer");
    button?.onClick?.();
    expect(onRunSlash).toHaveBeenCalledWith("model", "");
  });

  it("is absent off opencode", () => {
    const actions = composerActions(
      model({
        session: { source: "pi", sessionId: "p1" } as ComposerModel["session"],
      }),
    );
    expect(actions.some((action) => action.key === "switch-model")).toBe(false);
  });
});

describe("sending a slash command", () => {
  it("runs a listed command natively with the remainder as arguments", async () => {
    const onRunSlash = vi.fn(async () => {});
    const onSendMessage = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const setLocalDraft = vi.fn();
    const m = model({
      editorValue: "/review the last commit",
      session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
      sendAttachments: result.current,
      opencodeCommands: [{ name: "review", description: "review changes" }],
      onRunSlash,
      onSendMessage,
      setLocalDraft,
    } as Partial<ComposerModel>);
    await act(async () => {
      await submitComposer(m, "next");
    });
    expect(onRunSlash).toHaveBeenCalledWith("review", "the last commit");
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(setLocalDraft).toHaveBeenCalledWith("");
  });

  it("sends an unknown slash as text, which the serve reads literally", async () => {
    const onRunSlash = vi.fn(async () => {});
    const onSendMessage = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const m = model({
      editorValue: "/nope nothing",
      session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
      sendAttachments: result.current,
      opencodeCommands: [{ name: "review" }],
      onRunSlash,
      onSendMessage,
      setLocalDraft: vi.fn(),
    } as Partial<ComposerModel>);
    await act(async () => {
      await submitComposer(m, "next");
    });
    expect(onRunSlash).not.toHaveBeenCalled();
    expect(onSendMessage).toHaveBeenCalledWith("/nope nothing", "next", undefined);
  });

  it("hands the picker its filter under the catalogue's own name, whichever was typed", async () => {
    const onRunSlash = vi.fn(async () => {});
    const { result } = renderHook(() => useSendAttachments("opencode/s1"));
    const commands = [{ name: "model", aliases: ["models"], description: "Select a different model" }];
    for (const draft of ["/models spark", "/model spark"]) {
      const m = model({
        editorValue: draft,
        session: { source: "opencode", sessionId: "s1" } as ComposerModel["session"],
        sendAttachments: result.current,
        opencodeCommands: commands,
        onRunSlash,
        onSendMessage: vi.fn(async () => {}),
        setLocalDraft: vi.fn(),
      } as Partial<ComposerModel>);
      await act(async () => {
        await submitComposer(m, "next");
      });
    }
    // One name reaches the panel either way: the alias is a spelling, not a second command.
    expect(onRunSlash).toHaveBeenCalledTimes(2);
    expect(onRunSlash).toHaveBeenLastCalledWith("model", "spark");
  });
});

describe("the context meter's Compact button", () => {
  const tmux = (overrides: Partial<ComposerModel> = {}) =>
    model({
      session: { source: "claude", sessionId: "c1" } as ComposerModel["session"],
      isClaude: true,
      tmuxBand: true,
      cliSessionBand: false,
      agentTerminalBand: false,
      transport: { kind: "tmux-composer" },
      editorValue: "",
      unavailable: false,
      tmuxComposer: { pending: false, reason: null, submit: vi.fn(async () => true) } as never,
      ...overrides,
    });

  it("presses /compact in the pane, as typing it and pressing Return would", async () => {
    const m = tmux();
    const control = compactControl(m)!;
    expect(control.blocked).toBeNull();
    await expect(control.run()).resolves.toBe(true);
    expect(m.tmuxComposer.submit).toHaveBeenCalledWith("/compact");
  });

  it("refuses over a draft, which /compact would replace in the pane", () => {
    expect(compactControl(tmux({ editorValue: "half a thought" }))!.blocked).toBe(
      "Send or clear the draft in the composer first.",
    );
  });

  it("goes through opencode's command route, since the serve reads the text literally", async () => {
    const onRunSlash = vi.fn(async () => {});
    const control = compactControl(
      model({
        session: { source: "opencode", sessionId: "o1" } as ComposerModel["session"],
        isClaude: false,
        tmuxBand: false,
        cliSessionBand: false,
        agentTerminalBand: false,
        transport: { kind: "agent-session" },
        editorValue: "",
        tmuxComposer: { pending: false, reason: null } as never,
        onRunSlash,
      }),
    )!;
    await control.run();
    expect(onRunSlash).toHaveBeenCalledWith("compact", "");
  });

  it("a terminal session not yet mirrored attaches the pane and sends nothing", async () => {
    const engage = vi.fn();
    const m = tmux({
      tmuxBand: false,
      cliSessionBand: true,
      transport: { kind: "cli-session" },
      engage,
    });
    const control = compactControl(m)!;
    // It attaches the pane, the way reaching for the field does, and waits for it.
    expect(control.prepare).toBe(engage);
    expect(control.blocked).toBe("Reaching this session's terminal\u2026");
    await expect(control.run()).resolves.toBe(false);
  });

  it("says so when the session has no pane to type it into", () => {
    const control = compactControl(
      tmux({
        tmuxBand: false,
        cliSessionBand: true,
        transport: { kind: "cli-session" },
        tmuxComposer: { pending: false, reason: "no-pane" } as never,
      }),
    )!;
    expect(control.blocked).toBe("This session has no terminal the panel can type /compact into.");
  });

  it("is not offered where no door here takes a command", () => {
    expect(
      compactControl(
        model({
          tmuxBand: false,
          cliSessionBand: false,
          agentTerminalBand: false,
          transport: { kind: "agent-session" },
        }),
      ),
    ).toBeNull();
  });
});

describe("a terminal session's permission mode", () => {
  const terminal = (permissionMode: string | null, engage = vi.fn()) =>
    model({
      isClaude: true,
      sdkBand: false,
      engage,
      session: { source: "claude", sessionId: "c1" } as ComposerModel["session"],
      tmuxComposer: {
        pending: false,
        reason: null,
        permissionMode,
        choosePermissionMode: vi.fn(async () => {}),
      } as never,
    });

  it("opens the same menu as an SDK session's, bypass included, and sets the mode chosen", () => {
    const m = terminal("auto");
    const chip = composerActions(m).find((action) => action.key === "permission-mode")!;
    expect(chip.ariaLabel).toBe("Permission mode Auto, choose another");
    expect(chip.menu?.value).toBe("auto");
    // A terminal cannot say ahead of time whether its cycle reaches bypass, so it is offered.
    expect(chip.menu?.choices.every((choice) => choice.unavailable === undefined)).toBe(true);
    chip.menu!.onChoose("plan");
    expect(m.tmuxComposer.choosePermissionMode).toHaveBeenCalledWith("plan");
  });

  it("attaches the pane to read the mode before it offers to change one nobody has seen", () => {
    const engage = vi.fn();
    const chip = composerActions(terminal(null, engage)).find((action) => action.key === "permission-mode")!;
    expect(chip.menu).toBeUndefined();
    chip.onClick!();
    expect(engage).toHaveBeenCalled();
  });
});
