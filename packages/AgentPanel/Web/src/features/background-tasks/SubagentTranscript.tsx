import type { ActivityBlock } from "@agentdesk/agent-feed-wire";
import type {
  AgentDataSource,
  SessionReference,
} from "@/features/activity-feed/data-source/AgentDataSource";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { useSubagentTranscript } from "@/features/background-tasks/useSubagentTranscript";

/**
 * A subagent's transcript, rendered inside the task row that launched it.
 *
 * It deliberately does NOT reuse the activity feed's own event rows, and the reason is a
 * correctness one rather than a layout one. Those rows carry a `session` through to a "raw"
 * drawer that re-fetches a line by event index, and the only session this viewer has is the
 * PARENT's -- so every such fetch would read the parent's transcript at the subagent's index and
 * confidently show the wrong line. There is no raw route for a subagent, so the affordance is
 * absent rather than broken.
 *
 * What is left is the shape a panel row wants anyway: who spoke, and what they said.
 */

/** What a block contributes to a compact reading, or null when it contributes nothing. */
function blockText(block: ActivityBlock): string | null {
  switch (block.kind) {
    case "text":
    case "reasoning":
    case "plain":
      return block.text?.trim() || null;
    case "tool_use":
      return block.tool ? `${block.tool}${block.summary ? ` · ${block.summary}` : ""}` : null;
    case "tool_result":
      return block.preview?.trim() || block.summary?.trim() || null;
    default:
      return block.label?.trim() || null;
  }
}

const ROLE_LABEL: Record<string, string> = {
  assistant: "agent",
  user: "prompt",
  system: "system",
};

function EventRow({ event }: { event: ActivityEvent }) {
  const blocks = event.blocks ?? [];
  const isTool = blocks.every((block) =>
    block.kind === "tool_use" || block.kind === "tool_result"
  );
  const lines = blocks
    .map((block) => ({ block, text: blockText(block) }))
    .filter((entry): entry is { block: ActivityBlock; text: string } => entry.text !== null);
  if (lines.length === 0) return null;

  return (
    <li className="border-b border-border/40 px-3 py-1.5 last:border-b-0">
      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
        {ROLE_LABEL[event.type] ?? event.type}
      </span>
      {lines.map(({ block, text }, index) => (
        <p
          key={index}
          className={`whitespace-pre-wrap break-words text-[12px] ${
            block.kind === "reasoning"
              ? "text-muted-foreground italic"
              : isTool
              ? "font-mono text-[11px] text-muted-foreground"
              : "text-foreground"
          }`}
        >
          {/* Bounded per block. A single tool result can be tens of kilobytes, and this row is a
              narrow column inside a panel -- the run's own transcript is where you go to read it
              in full. */}
          {text.length > 600 ? `${text.slice(0, 600)}…` : text}
        </p>
      ))}
    </li>
  );
}

export function SubagentTranscript({
  source,
  session,
  agentId,
}: {
  source: AgentDataSource;
  session: SessionReference;
  agentId: string;
}) {
  const view = useSubagentTranscript(source, session, agentId);

  if (view.unavailable) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{view.unavailable}</p>;
  }
  if (!view.loaded) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Opening transcript…</p>;
  }
  if (view.events.length === 0) {
    // Loaded and genuinely empty, which is a launched run that has not written yet rather than a
    // failure. Said differently from `unavailable` on purpose.
    return <p className="px-3 py-2 text-xs text-muted-foreground">Nothing written yet.</p>;
  }

  return (
    <div className="border-t border-border">
      {view.forkOrigin ? (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
          Forked with {view.forkOrigin.contextLength.toLocaleString()} messages of context
        </p>
      ) : null}
      {/* Capped and scrolled rather than growing the panel: a long run would otherwise push every
          other task off the screen. */}
      <ul className="max-h-80 overflow-y-auto">
        {view.events.map((event) => <EventRow key={event.id} event={event} />)}
      </ul>
    </div>
  );
}
