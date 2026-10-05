"use client";

// Bodies for web tool results, chosen by the tool's name rather than by sniffing the text.
//
// A fetch result is never the page: it is prose a model wrote about the page, in Markdown, so it
// renders as Markdown. A search result has a fixed frame around its prose -- a query line, one
// `Links: [...]` JSON line per search it ran, and a closing reminder addressed to the model -- so
// the frame is taken apart and only the prose between is rendered. Detecting Markdown in arbitrary
// output is deliberately NOT done here: a shell's `#` comments would become headings and its single
// newlines would join into paragraphs, which is worse than the monospace box it replaced.

import { Markdown } from "@/features/activity-feed/markdown/Markdown";

export type WebResultBody =
  | { kind: "fetch"; markdown: string }
  | {
      kind: "search";
      links: { title: string; url: string }[];
      /** The prose between the frame lines; empty when the search returned only links. */
      markdown: string;
    };

const QUERY_LINE = /^Web search results for query: "(.*)"$/;
const LINKS_PREFIX = "Links: ";
const REMINDER_PREFIX = "REMINDER: ";

function isFetchTool(tool: string): boolean {
  return tool === "WebFetch" || tool === "webfetch";
}

function isSearchTool(tool: string): boolean {
  return tool === "WebSearch" || tool === "websearch";
}

/** One `Links:` line, or null when it is not the JSON array of `{title, url}` the frame promises. */
function parseLinks(line: string): { title: string; url: string }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(LINKS_PREFIX.length));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const links: { title: string; url: string }[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null;
    const { title, url } = entry as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
    links.push({ title: typeof title === "string" && title.trim() ? title.trim() : url, url });
  }
  return links;
}

/**
 * The body for a web tool's result, or null to keep the generic `pre`.
 *
 * A search whose frame does not parse returns null rather than a guess, for the reason
 * `parseSearchResult` does: an unknown output keeps its bytes.
 */
export function parseWebResult(tool: string | undefined, text: string): WebResultBody | null {
  if (typeof tool !== "string" || !text.trim()) return null;
  if (isFetchTool(tool)) return { kind: "fetch", markdown: text };
  if (!isSearchTool(tool)) return null;

  const lines = text.split("\n");
  // The query itself is not kept: the row's header already names it.
  if (!QUERY_LINE.test(lines[0]?.trim() ?? "")) return null;
  const links: { title: string; url: string }[] = [];
  const prose: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(LINKS_PREFIX)) {
      const parsed = parseLinks(line);
      if (parsed === null) return null;
      links.push(...parsed);
    } else if (!line.startsWith(REMINDER_PREFIX)) {
      prose.push(line);
    }
  }
  return {
    kind: "search",
    links,
    // The frame lines leave their blank lines behind; one paragraph break is all they meant.
    markdown: prose.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function WebResultBody({ body }: { body: WebResultBody }) {
  if (body.kind === "fetch") return <Markdown content={body.markdown} />;
  return (
    <div className="space-y-[0.5em]">
      {body.links.length > 0 ? (
        <ul
          aria-label="Search results"
          className="space-y-[0.15em] rounded-sm border border-border/50 bg-muted/30 px-2 py-1.5"
          style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
        >
          {body.links.map((link, index) => (
            <li key={`${link.url}-${index}`} className="flex min-w-0 items-baseline gap-2">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                title={link.url}
                className="min-w-0 truncate text-primary underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-primary"
              >
                {link.title}
              </a>
              <span className="shrink-0 text-[0.8em] text-muted-foreground">{hostOf(link.url)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {body.markdown ? <Markdown content={body.markdown} /> : null}
    </div>
  );
}
