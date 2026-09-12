"use client";

// The band as it is drawn, once every question about which band it is has been answered.
//
// Props rather than decisions: what is on screen is a field or a terminal, an action row,
// an optional caption, and whatever mirror the harness offers. Deciding which of those is
// `SessionComposer.tsx`'s job, and it is the only caller.

import type { ClipboardEvent } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { TokenMeter } from "@/features/activity-feed/TokenMeter";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import { terminalContextKey } from "@/features/terminal/terminalContext";
import type { SessionTmuxTerminalContext } from "@agentdesk/agent-feed-wire";
import { submitComposer } from "@/features/session-view/sessionComposerActions";
import type { useClaudeWindowQuestion } from "@/features/session-view/AskUserQuestionMirror";
import { List, Paperclip } from "lucide-react";
import { ComposerImageStrip } from "@/features/cli-input/ComposerImageStrip";
import { ComposerCommandList } from "@/features/cli-input/ComposerCommandList";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
import { AskUserQuestionMirror } from "@/features/session-view/AskUserQuestionMirror";
import type { ComposerAction } from "@/features/session-view/SessionComposer";
import type { ComposerModel } from "@/features/session-view/sessionComposerModel";
import type { ComposerEditor } from "@/features/session-view/sessionComposerEditor";

export function SessionComposerBand({
  actions,
  autoGrow,
  caption,
  captionIsError,
  composerFocused,
  editor,
  feed,
  filePicker,
  isClaude,
  isCodex,
  model,
  noteTerminalState,
  questionPanel,
  sectionLabel,
  session,
  setComposerFocused,
  softwareKeyboard,
  terminalComposer,
  terminalHeightBasis,
  terminalInput,
  tmuxBand,
  tmuxComposer,
  usage,
}: {
  actions: ComposerAction[];
  autoGrow: (element: HTMLTextAreaElement | null) => void;
  caption: string | null;
  captionIsError: boolean;
  composerFocused: boolean;
  editor: ComposerEditor;
  feed: Parameters<typeof AgentTerminalPane>[0]["feed"];
  filePicker: ComposerModel["filePicker"];
  isClaude: boolean;
  isCodex: boolean;
  model: ComposerModel;
  noteTerminalState: () => void;
  questionPanel: ReturnType<typeof useClaudeWindowQuestion>;
  sectionLabel: string;
  session: ComposerModel["session"];
  setComposerFocused: (focused: boolean) => void;
  softwareKeyboard: boolean;
  terminalComposer: {
    context: SessionTmuxTerminalContext;
    shown: boolean;
    toggle: () => void;
  } | null;
  terminalHeightBasis: HTMLElement | null;
  terminalInput: {
    context: SessionTmuxTerminalContext;
    shown: boolean;
    toggle: () => void;
  } | null;
  tmuxBand: boolean;
  tmuxComposer: ComposerModel["tmuxComposer"];
  usage: TokenUsage | null;
}) {
  return (
    <section aria-label={sectionLabel} className="shrink-0 border-t border-border bg-card px-6 py-3">
      {questionPanel.visible ? (
        <AskUserQuestionMirror
          question={questionPanel.question!}
          optionsExpanded={questionPanel.optionsExpanded}
          selected={questionPanel.selected}
          otherText={questionPanel.otherText}
          otherChecked={questionPanel.otherChecked}
          pending={questionPanel.pending}
          disabled={!questionPanel.enabled}
          error={questionPanel.error}
          onSelectOption={questionPanel.selectOption}
          onChangeOther={questionPanel.changeOther}
          onToggleOther={questionPanel.toggleOther}
          onToggleOptions={questionPanel.toggleOptions}
          onSubmit={questionPanel.submit}
          onSkip={questionPanel.skip}
          onDismiss={questionPanel.dismiss}
        />
      ) : null}
      {/* The session's own terminal, INSTEAD of the field rather than above it.

          Both are ways of typing at the same session -- the field sends a turn through the harness,
          the terminal types into the process -- and which one you want changes between asking it
          something and answering its own prompt. But wanting both at once is not a thing that
          happens, and showing both spent two thirds of the band on input while the transcript they
          are about went to a sliver. So the button below switches between them and the transcript
          keeps the difference.

          Keyed by the pane so switching sessions tears the old attach down rather than repointing a
          live one, and scrolling rather than resizing, because the terminal renders at the pane's
          own geometry -- imposing a size here would reflow the session in whatever terminal its
          owner has it open in. */}
      {terminalInput ? (
        // `AgentTerminalPane` rather than a tile: it is the same hook underneath and it already
        // owns the resize handle, the header and the footer. It takes a tmux context as readily as
        // an agent-session one, so the composer needed no second copy of any of that.
        //
        // Its `band` layout, so the pane's height IS the band's height: nothing reserves a box
        // around it to leave blank, and a drag upward makes the whole band taller rather than
        // growing the pane down into reserved space. A share of the session's column rather than
        // of the viewport, because the session is not always the page.
        <div className="mb-2">
          <AgentTerminalPane
            key={terminalContextKey(terminalInput.context)}
            feed={feed}
            context={terminalInput.context}
            onState={noteTerminalState}
            layout="band"
            heightBasis={terminalHeightBasis}
          />
        </div>
      ) : null}
      {tmuxBand ? (
        <input
          ref={filePicker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            // Cleared so picking the same file twice in a row fires a second change; the input
            // remembers its value and would otherwise say nothing happened.
            event.target.value = "";
            if (chosen.length > 0) void tmuxComposer.drop(chosen);
          }}
        />
      ) : null}
      {/* Above the field rather than under it, which is where Claude draws it: under the panel's
          field are the key rail, the send button and then a phone's keyboard, so a list there is
          behind the thumb reaching for it. Open only while the pane's own menu is, which is only
          while somebody is part-way through a command. */}
      {editor.commands && editor.commands.shown.length > 0 && !terminalInput ? (
        <ComposerCommandList
          commands={editor.commands.shown}
          onChoose={editor.commands.onChoose}
        />
      ) : null}
      <div className={`flex items-end gap-1.5 ${terminalInput ? "justify-end" : ""}`}>
        {terminalInput ? null : <div
          // The box is this wrapper rather than the field, so the images sit INSIDE it, above the
          // text, the way the composer they are mirroring holds them. The field keeps its own
          // scrolling and auto-grow and gives up only its border.
          // No drop handlers of its own: the whole session card is the target, and a second set
          // here would take the same drop again on the way past, putting the image in twice.
          className={`flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-background shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25 ${
            editor.disabled ? "opacity-40" : ""
          }`}
        >
          {editor.images && editor.onRemoveImage ? (
            <ComposerImageStrip
              images={editor.images}
              onRemove={editor.onRemoveImage}
              disabled={editor.disabled}
            />
          ) : null}
          <textarea
          ref={autoGrow}
          value={editor.value}
          onChange={(event) => editor.onChange(event.target.value)}
          onFocus={() => {
            setComposerFocused(true);
            editor.onFocus?.();
          }}
          onBlur={() => {
            setComposerFocused(false);
            editor.onBlur?.();
          }}
          // A pasted image is the same arrival as a dropped one, and on a phone it is the only
          // one: there is no drag there. Text pastes fall through untouched, because a clipboard
          // carrying files is a different clipboard from one carrying words.
          {...(editor.onFiles === undefined ? {} : {
            onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              editor.onFiles?.(files);
            },
          })}
          onKeyDown={(event) => {
            // Tab takes the offer rather than leaving the field, but only while there IS one:
            // with no suggestion to accept it stays the key that moves focus.
            if (editor.onAcceptHint && event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              editor.onAcceptHint();
              return;
            }
            if (
              editor.sendOnEnter &&
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submitComposer(model, "next");
            }
          }}
          maxLength={editor.maxLength}
          rows={1}
          placeholder={editor.placeholder}
          aria-label={editor.ariaLabel}
          disabled={editor.disabled}
          className="max-h-48 min-h-12 w-full resize-none bg-transparent px-4 py-3 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none"
        />
        </div>}
        {/* Offered only where there is a pane: a session without one has nothing to show. The one
            control that survives the swap, because it is the way back from either side. A draft
            typed in the field is still in this component's state while the terminal has the band,
            so switching away and back does not cost it. */}
        {terminalComposer ? (
          <button
            type="button"
            onClick={terminalComposer.toggle}
            aria-pressed={terminalComposer.shown}
            aria-label={terminalComposer.shown ? "Hide the terminal" : "Show the terminal"}
            title={terminalComposer.shown
              ? "Hide this session's terminal and type in the composer instead."
              : "Type in this session's terminal instead, resuming it in tmux if nothing is running it."}
            className={`flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary active:bg-muted ${
              terminalComposer.shown
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {/* The thing it opens: a terminal. It used to be a dotted square, which named
                nothing -- the pressed state is what says whether it is open. */}
            <TerminalIcon className="size-4" aria-hidden />
          </button>
        ) : null}
        {/* Every one of these acts on the draft, so they go where the draft goes. */}
        {terminalInput ? null : actions.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-label={action.ariaLabel}
            title={action.title}
            className={action.className}
          >
            {action.icon}
          </button>
        ))}
      </div>
      {/* Under the whole row rather than inside the field's box, because it is not part of the
          text: it stands between the composer and the keyboard, which is where a thumb coming off
          the keys reaches first. Only where the keyboard is actually missing these keys -- a
          desktop browser has Esc and Ctrl already, and a rail there would spend a row saying so. */}
      {editor.rail && composerFocused && softwareKeyboard ? (
        <TerminalKeyRail
          modifiers={editor.rail.modifiers}
          onModifier={editor.rail.onModifier}
          onKey={editor.rail.onKey}
        />
      ) : null}
      {/* The context meter sits below the action row, right-aligned under the
          buttons in the window band, not in the header. */}
      {usage ? (
        <div className="mt-1 flex justify-end px-1">
          <TokenMeter usage={usage} />
        </div>
      ) : null}
      {caption ? (
        <p
          {...(isClaude || isCodex
            ? { "aria-live": "polite" as const }
            : { role: captionIsError ? ("alert" as const) : ("status" as const) })}
          className={`px-1 pt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) ${
            captionIsError ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {caption}
        </p>
      ) : null}
    </section>
  );
}
