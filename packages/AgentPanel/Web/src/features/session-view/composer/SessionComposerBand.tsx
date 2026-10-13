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
import type { ComposerPaneContext } from "@/features/session-view/composer/terminalArrangement";
import { COMPOSER_FOOTER_BUTTON_CLASS, compactControl, submitComposer } from "@/features/session-view/composer/sessionComposerActions";
import type { AskUserQuestionItem } from "@/app/askUserQuestion";
import type { QuestionDraft } from "@/features/session-view/composer/question/questionAnswers";
import { List, Paperclip } from "lucide-react";
import { ComposerImageStrip } from "@/features/cli-input/ComposerImageStrip";
import { ComposerPasteStrip } from "@/features/cli-input/ComposerPasteStrip";
import { ComposerCommandList } from "@/features/cli-input/ComposerCommandList";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
import { AskUserQuestionMirror } from "@/features/session-view/composer/question/AskUserQuestionMirror";
import type { QuestionMirrorModel } from "@/features/session-view/composer/question/useQuestionMirror";
import { OpencodeModelsHost } from "@/features/bots/dialogs/OpencodeModelsDialog";
import { OpencodeAsideDialog } from "@/features/session-view/OpencodeAsideDialog";
import type { PanelCommandSurfaces } from "@/features/session-view/usePanelCommands";
import type { ComposerAction } from "@/features/session-view/composer/SessionComposer";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import type { ComposerEditor } from "@/features/session-view/composer/sessionComposerEditor";
import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";

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
  surfaces,
  noteTerminalState,
  onPickFiles,
  questionMirror,
  sectionLabel,
  session,
  setComposerFocused,
  softwareKeyboard,
  terminalComposer,
  terminalHeightBasis,
  terminalPane,
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
  /** Takes the images the picker returns, or null where this session has nowhere to put one. */
  onPickFiles: ComposerModel["acceptFiles"];
  isClaude: boolean;
  isCodex: boolean;
  model: ComposerModel;
  /** The models menu the switcher button or `/models` opened, or null while closed. */
  /** What a slash command left open over the composer: the model picker, or the `/btw` answer. */
  surfaces: PanelCommandSurfaces;
  noteTerminalState: () => void;
  /** The open question and the way to answer it, or null when there is none. */
  questionMirror: QuestionMirrorModel | null;
  sectionLabel: string;
  session: ComposerModel["session"];
  setComposerFocused: (focused: boolean) => void;
  softwareKeyboard: boolean;
  terminalComposer: {
    context: ComposerPaneContext;
    shown: boolean;
    toggle: () => void;
  } | null;
  terminalPane: {
    context: ComposerPaneContext;
    layout: "band" | "echo";
    height: number | null;
    onResized: (height: number) => void;
  } | null;
  terminalHeightBasis: HTMLElement | null;
  usage: TokenUsage | null;
}) {
  // Split off the call id, which is the mirror's key rather than one of its props: the surface
  // pages between the call's questions, and a new call starts at its own first one.
  const question = questionMirror
    ? { callId: questionMirror.callId, mirror: withoutCallId(questionMirror) }
    : null;
  const fieldActions = actions.filter((action) => action.placement === "field");
  const footerActions = actions.filter((action) => action.placement === "footer");
  const rowActions = actions.filter((action) => action.placement === undefined);
  return (
    <section aria-label={sectionLabel} className={`shrink-0 border-t session-view-dock ${COLUMN_GUTTER_CLASS} py-3`}>
      {question ? <AskUserQuestionMirror key={question.callId} {...question.mirror} /> : null}
      {/* The session's own terminal: beside the field, or instead of it.

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
      {terminalPane ? (
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
            key={terminalContextKey(terminalPane.context)}
            feed={feed}
            context={terminalPane.context}
            onState={noteTerminalState}
            layout={terminalPane.layout}
            heightBasis={terminalHeightBasis}
            rememberedHeight={terminalPane.height}
            onResized={terminalPane.onResized}
          />
        </div>
      ) : null}
      {/* Rendered wherever an image has somewhere to go rather than only on the attached band: the
          paperclip that clicks it is offered on the same rule, and the picker has to exist before
          the reader can reach it. `onPickFiles` engages the mirror and drops, which is exactly
          what dropping on the card does. */}
      {onPickFiles ? (
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
            if (chosen.length > 0) onPickFiles(chosen);
          }}
        />
      ) : null}
      {/* Above the field rather than under it, which is where Claude draws it: under the panel's
          field are the key rail, the send button and then a phone's keyboard, so a list there is
          behind the thumb reaching for it. Open only while the pane's own menu is, which is only
          while somebody is part-way through a command. */}
      {editor.commands && editor.commands.shown.length > 0 ? (
        <ComposerCommandList
          commands={editor.commands.shown}
          onChoose={editor.commands.onChoose}
        />
      ) : null}
      <div className="flex items-end gap-1.5">
        <div
          // The box is this wrapper rather than the field, so the images sit INSIDE it, above the
          // text, the way the composer they are mirroring holds them. The field keeps its own
          // scrolling and auto-grow and gives up only its border.
          // No drop handlers of its own: the whole session card is the target, and a second set
          // here would take the same drop again on the way past, putting the image in twice.
          className={`flex min-w-0 flex-1 flex-col rounded-xl border session-view-field shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25 ${
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
          {editor.pastes && editor.onPreviewPaste && editor.onExpandPaste && editor.onRemovePaste ? (
            <ComposerPasteStrip
              pastes={editor.pastes}
              onPreview={editor.onPreviewPaste}
              onExpand={editor.onExpandPaste}
              onRemove={editor.onRemovePaste}
              disabled={editor.disabled}
            />
          ) : null}
          <div className="flex items-end">
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
              // A panel-owned command list eats Return first: without this the half-typed name
              // sends as text. The pane's own menu is untouched -- it never sets chooseOnEnter,
              // because the pane eats Return itself.
              //
              // One job, and the list decides which by being open or not. While it is open the
              // reader is choosing a name, so Return takes the highlighted row; the opencode
              // list closes on the first space (the web client's own rule), so a draft that
              // already carries arguments has no list and Return submits -- the same thing the
              // Send button does. `/compact` plus Enter runs it, `/comp` plus Enter completes.
              if (editor.commands?.chooseOnEnter && editor.commands.shown.length > 0) {
                event.preventDefault();
                const selected = editor.commands.shown.find((command) => command.selected)
                  ?? editor.commands.shown[0];
                if (selected) editor.commands.onChoose(selected.name);
                return;
              }
              event.preventDefault();
              void submitComposer(model, "next");
            }
          }}
          maxLength={editor.maxLength}
          rows={1}
          placeholder={editor.placeholder}
          aria-label={editor.ariaLabel}
          disabled={editor.disabled}
          className={`max-h-48 min-h-12 min-w-0 flex-1 resize-none bg-transparent py-3 pl-4 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none ${
            fieldActions.length > 0 ? "pr-2" : "pr-4"
          }`}
        />
          {fieldActions.map(actionButton)}
          </div>
        </div>
        {/* Every one of these acts on the draft, so they go where the draft goes. */}
        {rowActions.map(actionButton)}
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
      {/* One small line under the field: the things that change what the composer holds or shows on
          the left, the context meter on the right. They were a row of full-size buttons beside the
          field, which on a narrow card spent a third of the width the draft needed. */}
      {footerActions.length > 0 || terminalComposer || usage ? (
        <div className="relative mt-1 flex items-center gap-0.5 px-1">
          {/* The models menu, rising from the footer cluster that holds its switcher -- a narrow
              drop-up at the footer's own left, over the field and transcript, rather than a modal
              in the middle of the card or a full-width sheet above the field. */}
          {surfaces.models ? (
            <OpencodeModelsHost
              feed={feed}
              current={model.sessionModel ?? usage?.model ?? null}
              initialFilter={surfaces.models.filter}
              onClose={surfaces.models.onClose}
              onSwitch={surfaces.models.onSwitch}
            />
          ) : null}
          {/* The same edge and the same rise as the picker: both are something a slash command
              opened over the composer, and a reader who typed `/btw` should not find a dialog
              from an earlier command still in the way. */}
          {surfaces.aside ? (
            <OpencodeAsideDialog
              aside={surfaces.aside}
              onAsk={surfaces.onAskAside}
              onClose={surfaces.onCloseAside}
            />
          ) : null}
          {footerActions.filter((action) => !TRAILING_FOOTER_KEYS.has(action.key)).map(actionButton)}
          {/* Before the model switcher and the permission mode, not after them: the icon and the
              chooser read as one control, icon first, and the mode chip sits at the cluster's end
              beside the meter. Splitting on those keys leaves a band without them as it was. */}
          {terminalComposer ? (
            <button
              type="button"
              onClick={terminalComposer.toggle}
              aria-pressed={terminalComposer.shown}
              aria-label={terminalComposer.shown ? "Hide the terminal" : "Show the terminal"}
              title={terminalComposer.shown
                ? "Hide this session's screen and keep only the composer."
                : "Show this session's screen above the composer, so text typed here can be watched"
                  + " arriving in the agent's own composer line."}
              className={`${COMPOSER_FOOTER_BUTTON_CLASS} ${
                terminalComposer.shown
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {/* The thing it opens: a terminal. The pressed state is what says whether it is open. */}
              <TerminalIcon className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {footerActions.filter((action) => TRAILING_FOOTER_KEYS.has(action.key)).map(actionButton)}
          {usage ? (
            <div className="ml-auto">
              <TokenMeter
                usage={usage}
                // Opencode answers spend, not windows: Claude's 5h/7d chips are another
                // vendor's answer about to stop you, and opencode's own limits live in
                // its console rather than any feed this meter could read.
                feed={isClaude || isCodex ? feed : null}
                vendor={isCodex ? "codex" : isClaude ? "claude" : null}
                compact={compactControl(model)}
              />
            </div>
          ) : null}
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

function actionButton(action: ComposerAction) {
  return (
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
  );
}

// Footer actions that render after the terminal toggle rather than before it.
const TRAILING_FOOTER_KEYS: ReadonlySet<string> = new Set(["permission-mode", "switch-model"]);

function withoutCallId({ callId: _callId, ...mirror }: QuestionMirrorModel) {
  return mirror;
}
