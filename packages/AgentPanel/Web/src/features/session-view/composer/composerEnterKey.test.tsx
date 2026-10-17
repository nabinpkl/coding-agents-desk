/**
 * Enter in the composer field, where a panel-owned command list is open.
 *
 * The bug this file exists for: Enter on a listed slash command took the picker's "complete the
 * name" branch every time, and because the filter matched the first whitespace-delimited token,
 * `/compact` became `/compact ` and the list stayed open. Enter re-completed the same name
 * forever, so the command could only be run by clicking Send. A person typing `/compact` and
 * pressing Enter got a field that shrugged.
 *
 * What replaced it is the web client's own rule: the list exists only while the draft is a
 * slash and a name (`/^\/(\S*)$/`), so an open list means a name is still being chosen and a
 * closed one means Return is a submit. The exactness test that used to stand in for that is
 * gone, and these cases are what it has to keep saying.
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
  { name: "compact", description: "Summarize the session to reduce context size" },
  { name: "model", aliases: ["models"], description: "Select a different model" },
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
    deliveryError: null,
    deliveryPending: false,
    editorValue: localDraft,
    filePicker: { current: null },
    cliSessionBand: false,
    isClaude: false,
    isCodex: false,
    localDraft,
    onAbort: vi.fn(),
    onRunSlash: vi.fn(async () => {}),
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

function band(model: ComposerModel) {
  const editor = composerEditor(model);
  return (
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
      surfaces={{ models: null, aside: null, onAskAside: () => {}, onCloseAside: () => {} }}
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
    />
  );
}

function renderBand(model: ComposerModel) {
  return render(band(model));
}

function field(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("Enter with the opencode command list open", () => {
  it("completes a name that is still being chosen, then runs it on the next Return", () => {
    const onRunSlash = vi.fn(async () => {});
    const setLocalDraft = vi.fn();
    // What a person typing `/compact` gets, and what both opencode clients give: the list is
    // open while the draft is a slash and a name, so the first Return takes the highlighted row.
    const typing = opencodeModel({ localDraft: "/compact", onRunSlash, setLocalDraft });
    const { rerender } = renderBand(typing);
    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });
    expect(setLocalDraft).toHaveBeenCalledWith("/compact ");
    expect(onRunSlash).not.toHaveBeenCalled();

    // The draft the picker left behind now carries the space, so the list is closed and Return is
    // a submit. This is the whole reason the list closes there rather than staying open on the
    // first token: a Return that always completed could never run anything.
    const completed = opencodeModel({ localDraft: "/compact ", onRunSlash, setLocalDraft });
    rerender(band(completed));
    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });
    expect(onRunSlash).toHaveBeenCalledWith("compact", "");
  });

  it("completes a half-typed name instead of running something the reader did not name", () => {
    const onRunSlash = vi.fn(async () => {});
    const setLocalDraft = vi.fn();
    const model = opencodeModel({ localDraft: "/comp", onRunSlash, setLocalDraft });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(setLocalDraft).toHaveBeenCalledWith("/compact ");
    expect(onRunSlash).not.toHaveBeenCalled();
  });

  it("runs with its arguments rather than swallowing them", () => {
    const onRunSlash = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "/compact keep the decisions", onRunSlash });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(onRunSlash).toHaveBeenCalledWith("compact", "keep the decisions");
  });

  it("runs an alias as the command it names, so `/models` reaches the model picker", () => {
    const onRunSlash = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "/models opus", onRunSlash });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(onRunSlash).toHaveBeenCalledWith("model", "opus");
  });

  it("sends ordinary text untouched, because no command is named", () => {
    const onSendMessage = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "just a sentence", onSendMessage });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });

    expect(onSendMessage).toHaveBeenCalledWith("just a sentence", "next", undefined);
  });

  it("leaves Shift+Enter to insert a newline", () => {
    const onRunSlash = vi.fn(async () => {});
    const onSendMessage = vi.fn(async () => {});
    const model = opencodeModel({ localDraft: "/compact", onRunSlash, onSendMessage });
    renderBand(model);

    fireEvent.keyDown(field(), { key: "Enter", code: "Enter", shiftKey: true });

    expect(onRunSlash).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
