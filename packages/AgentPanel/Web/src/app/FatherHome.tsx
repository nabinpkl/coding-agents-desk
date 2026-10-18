// The Father home's stand in the shell: its switch and its drawer, one idea.
//
// The switch stands in the header bar every view shares, or floats over the corner where there
// is no bar (the headerless pinned canvas). The drawer is `fixed`, so it can live beside the
// switch here and still draw over the strip from the top of the page on any view. The open state
// is owned here and written to storage on every change, so closing the home and reopening the
// panel agree -- and so a header that comes back (pin, unpin, view switch) finds the stored
// answer rather than a default.
//
// This is the bar-less mounts' home. Where a surface bar owns the switch, the site-wide scope
// stands the drawer instead and this renders nothing.

import type { AgentSessionDescriptor, BotSessionRef, BotView } from "@agentdesk/agent-feed-wire";
import { FatherButton, FatherOverlay } from "@/features/bots/canvas/FatherOverlay";
import { loadFatherOpen, storeFatherOpen } from "@/features/bots/canvas/fatherPreferences";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { usePersistentState } from "@/hooks/state/usePersistentState";

export function FatherHome({
  floating,
  bots,
  sessionContextFor,
  attachSessionToBot,
  onDetachSession,
  botError,
}: {
  /** The headerless canvas has no bar to stand in, so the switch floats over its corner. */
  floating: boolean;
  /** The arranged roster rather than the canvas's subset: taking a Bot off the canvas must not
      close a home its record still names. */
  bots: BotView[];
  /** The context one card renders its session in, by Bot: a peer's Father reads peer-side. */
  sessionContextFor: (botId: string) => SessionViewContext;
  /** A function of the Bot: the home knows the session, only the shell knows whose it is. */
  attachSessionToBot: (bot: BotView) => (session: AgentSessionDescriptor) => void | Promise<void>;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  /** A failure from editing a Bot, shown when it is about the Father session. */
  botError: BotCommandError | null;
}) {
  const [fatherOpen, setFatherOpen] = usePersistentState(loadFatherOpen, storeFatherOpen);

  return (
    <>
      <FatherButton
        open={fatherOpen}
        // A real toggle now that the switch stays on screen: the same press that opens the home
        // puts it away again.
        onToggle={() => setFatherOpen((was) => !was)}
        floating={floating}
      />
      {fatherOpen ? (
        <FatherOverlay
          bots={bots}
          sessionContextFor={sessionContextFor}
          attachSessionToBot={attachSessionToBot}
          onDetachSession={onDetachSession}
          botError={botError}
          onClose={() => setFatherOpen(false)}
        />
      ) : null}
    </>
  );
}
