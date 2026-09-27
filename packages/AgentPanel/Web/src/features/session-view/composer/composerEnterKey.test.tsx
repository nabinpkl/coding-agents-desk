/**
 * Enter in the composer field, where a panel-owned command list is open.
 *
 * The bug this file exists for: Enter on a listed slash command took the picker's "complete the
 * name" branch every time, and because the filter matches the first whitespace-delimited token,
 * `/compact` became `/compact ` and the list stayed open. Enter re-completed the same name
 * forever, so the command could only be run by clicking Send. A person typing `/compact` and
 * pressing Enter got a field that shrugged.
 *
 * Driven through the band's own textarea and a real keydown, because that handler is where the
 * decision lives: a test of the row filter or the submit path alone would pass while the field
 * still refused to send.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionComposerBand } from "@/features/session-view/composer/SessionComposerBand";
import { composerEditor } from "@/features/session-view/composer/sessionComposerEditor";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";

const COMMANDS = [
  { name: "compact", description: "Summarize this session to free context" },
  { name: "review", description: "Review the working tree" },
];

function opencodeModel(overrides: Partial<ComposerModel> = {}): ComposerModel {
  // `editorValue` is what the submit path reads, and the real composer derives it from whichever
  // transport owns the field. For this band that is the local draft, so a test that sets one
  // without the other would be testing a composer with an empty field.
  const localDraft = overrides.localDraft ?? "";
  return {
    capabilities: {
      modes: ["nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: true,
      canStreamLive: false,
    },
    acceptFiles: null,
    agentTerminalBand: false,
    cliInput: { available: false, refresh: () => {}, send: async () => false } as never,
    deliveryError: null,
    deliveryPending: false,
    editorValue: localDraft,
    filePicker: { current: null },
    inboxBand: false,
    isClaude: false,
    isCodex: false,
    localDraft,
    onAbort: vi.fn(),
    onOpenModels: vi.fn(),
    onRunCommand: vi.fn(async () => {}),
    onSendMessage: vi.fn(async () => {}),
    opencodeCommands: COMMANDS,
    pending: false,
    queued: 0,
    running: false,
    sendAttachments: { images: [], attach: vi.fn(), remove: vi.fn(), clear: vi.fn(), toWire: vi.fn() } as never,
    session: { source: "opencode", sessionId: "s1" } as never,
    setDeliveryError: vi.fn(),
    setDeliveryPending: vi.fn(),
    setLocalDraft: vi.fn(),
    state: "idle",
    tmuxBand: false,
    tmuxComposer: {} as never,
    transport: { kind: "agent-session" },
    unavailable: false,
    ...overrides,
  } as ComposerModel;
}

function renderBand(model: ComposerModel) {
  const editor = composerEditor(model);
  return render(
    <SessionComposerBand
      actions={[]}
      autoGrow={() => {}}
      caption={null}
      captionIsError={false}
      composerFocused={false}
      editor={editor}
      feed={{} as never}
      filePicker={model.filePicker}
      isClaude={false}
      isCodex={false}
      model={model}
      modelsMenu={null}
      noteTerminalState={() => {}}
      onPickFiles={null}
      questionMirror={null}
      sectionLabel="Message"
      session={model.session}
      setComposerFocused={() => {}}
      softwareKeyboard={false}
      terminalComposer={null}
      terminalHeightBasis={null}
      terminalPane={null}
      usage={null}
    />,
  );
}

function field(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("Enter with the opencode command list open", () => {
  it("runs the command when the draft already names it", () => {
    const onRunCommand = vi.fn(async () => {});
    // `/compact ` is what the picker leaves behind after one completion, and what a person
    // typing the name themselves ends up with. Enter here means "run it", the same as Send.
    const model = opencodeModel({ localDraft: "/compact ", onRunCommand });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(onRunCommand).toHaveBeenCalledWith("compact", "");
    // The run owns clearing the draft; Enter must not also rewrite the field underneath it.
    expect(model.setLocalDraft).not.toHaveBeenCalled();
  });

  it("completes a half-typed name instead of running something the reader did not name", () => {
    const onRunCommand = vi.fn(async () => {});
    const setLocalDraft = vi.fn();
    const model = opencodeModel({ localDraft: "/comp", onRunCommand, setLocalDraft });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(setLocalDraft).toHaveBeenCalledWith("/compact ");
    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("runs with its arguments rather than swallowing them", () => {
    const onRunCommand = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "/compact keep the decisions", onRunCommand });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(onRunCommand).toHaveBeenCalledWith("compact", "keep the decisions");
  });

  it("sends ordinary text untouched, because no command is named", () => {
    const onSendMessage = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "just a sentence", onSendMessage });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(onSendMessage).toHaveBeenCalledWith("just a sentence", "next", undefined);
  });

  it("leaves Shift+Enter to insert a newline", () => {
    const onRunCommand = vi.fn(async () => {});
    const onSendMessage = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "/compact", onRunCommand, onSendMessage });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter", shiftKey: true });

    expect(onRunCommand).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
