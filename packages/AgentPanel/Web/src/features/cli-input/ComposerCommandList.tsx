import type { ComposerCommand } from "@agentdesk/agent-feed-wire";

/**
 * The command menu the pane is showing, put where the reader can see and reach it.
 *
 * The list is Claude's own, read off its screen, so it carries this session's plugins, its
 * project's commands and whatever skills it loaded -- and it filters as the name is typed, because
 * what is being mirrored is a menu that filters. Nothing here decides what is in it.
 *
 * Above the field rather than below it. Claude draws it under its box, but the panel's box has the
 * key rail and the send button under it and, on a phone, the keyboard under those; a list put
 * there is behind the thumb that is typing into it.
 *
 * Only what fits on the PANE's screen ever arrives, so this is a shortlist and not a catalogue.
 * That is the same bargain the terminal makes, and the way past it is the same: type more of the
 * name.
 */
export function ComposerCommandList({
  commands,
  onChoose,
}: {
  commands: readonly ComposerCommand[];
  onChoose: (name: string) => void;
}) {
  return (
    <div
      // A press here must never take focus. The field losing it would take a phone's keyboard down
      // with it, and the list only exists while somebody is mid-word in that field.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      className="mb-1.5 max-h-56 overflow-y-auto overscroll-contain rounded-xl border border-border bg-background shadow-xs"
      role="listbox"
      aria-label="Commands this session offers"
    >
      {commands.map((command) => (
        <button
          key={command.name}
          type="button"
          role="option"
          // What Return would run right now, which is what the key rail's arrows move. Said in the
          // accessibility tree as well as in the colour, because "the highlighted one" is not a
          // fact a screen reader can see.
          aria-selected={command.selected}
          onClick={() => onChoose(command.name)}
          className={`flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-accent ${
            command.selected ? "bg-accent" : ""
          }`}
        >
          <span className="shrink-0 font-mono text-(length:--agent-panel-fs-sidebar-body,15px) text-foreground">
            {command.name}
          </span>
          {/* The description is a caption for the name beside it, which is the row's content. A
              long one is elided by Claude before it ever gets here, so this only has to stop it
              pushing the name out of the row. */}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {command.description}
          </span>
        </button>
      ))}
    </div>
  );
}
