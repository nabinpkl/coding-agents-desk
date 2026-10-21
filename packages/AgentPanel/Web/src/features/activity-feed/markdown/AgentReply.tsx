"use client";

import type { ReactNode } from "react";
import { ArrowRight, ListChecks, Volume2, type LucideIcon } from "lucide-react";
import { ReadAloudButton } from "@/features/audio-channel/ReadAloudButton";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import {
  SPOKEN_KIND_INK,
  SPOKEN_KIND_LABEL,
  splitReply,
  type ReplySegment,
} from "@/features/activity-feed/markdown/replyReports";

/**
 * An agent's reply in the feed: its prose as Markdown, and each block it wrote about its own turn
 * (`replyReports.ts`) as a section under its own heading, so the task it took on, how the turn
 * stands and what to do next read as what they are rather than as one run-together paragraph. Once
 * it has landed it ends in a speaker that reads it out loud (`ReadAloudButton`).
 */
export function AgentReply({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const segments = splitReply(content);
  return (
    <div className="flex flex-col gap-(--agent-panel-md-block-gap)">
      {segments.map((segment, at) => {
        // Only the last segment of a reply still being written can still change.
        const live = streaming && at === segments.length - 1;
        if (segment.kind === "prose") return <Markdown key={at} content={segment.text} streaming={live} />;
        return <ReplyReport key={at} segment={segment} />;
      })}
      {streaming ? null : <ReadAloudButton text={content} />}
    </div>
  );
}

function ReportSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-2">
      <h4 className="session-muted-ink mb-1 flex items-center gap-1.5 text-[0.75em] font-semibold tracking-[0.06em] uppercase">
        <Icon aria-hidden className="size-[1.2em] shrink-0" />
        {title}
      </h4>
      {children}
    </section>
  );
}

/** Text a session wrote inside a block, which may carry inline Markdown (`code`, emphasis). */
function Inline({ text }: { text: string }) {
  return <Markdown content={text} />;
}

function ReplyReport({ segment }: { segment: Exclude<ReplySegment, { kind: "prose" }> }) {
  if (segment.kind === "task") {
    return (
      <ReportSection icon={ListChecks} title="Task">
        {segment.task ? (
          <div className="font-medium">
            <Inline text={segment.task} />
          </div>
        ) : null}
        {segment.decisions.length > 0 ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {segment.decisions.map((decision, at) => (
              <li key={at}>
                <Inline text={decision} />
              </li>
            ))}
          </ul>
        ) : null}
      </ReportSection>
    );
  }
  if (segment.kind === "status") {
    return (
      <ReportSection icon={Volume2} title="Status">
        <ul className="space-y-0.5">
          {segment.lines.map((line, at) => (
            <li key={at} className="text-pretty">
              <span className={SPOKEN_KIND_INK[line.kind]}>{SPOKEN_KIND_LABEL[line.kind]}:</span> {line.text}
            </li>
          ))}
        </ul>
      </ReportSection>
    );
  }
  return (
    <ReportSection icon={ArrowRight} title="Next steps">
      <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
        {segment.items.map((item, at) => (
          <li key={at}>
            <Inline text={item} />
          </li>
        ))}
      </ol>
    </ReportSection>
  );
}
