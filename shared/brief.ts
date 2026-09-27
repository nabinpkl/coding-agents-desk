/* Markdown brief an agent can act on. Used by the server's brief tool and the
 * extension's Copy / Download actions. No DOM access. */
import type { ElementMetadata, Tag } from "./annotation.ts";
import { TAG_MEANINGS } from "./vocab.ts";

export interface BriefItem {
  text: string;
  tag: Tag;
  metadata: ElementMetadata;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/`/g, "'");
}

function one(a: BriefItem, i: number): string {
  const m = a.metadata;
  const lines = [`## Feedback #${i + 1}`, `> ${esc(a.text)}`, ""];
  lines.push(`- **Element:** \`${esc(m.tagName || "?")}\``);
  lines.push(`- **Selector:** \`${esc(m.selector || "?")}\``);
  if (m.fullPath) lines.push(`- **Path:** \`${esc(m.fullPath)}\``);
  if (m.classes) lines.push(`- **Classes:** \`${esc(m.classes)}\``);
  if (m.text) lines.push(`- **Text:** "${esc(m.text.slice(0, 200))}"`);
  if (m.component) lines.push(`- **Component:** \`${esc(m.component)}\``);
  if (m.bbox) {
    const b = m.bbox;
    lines.push(`- **Box:** x=${b.x} y=${b.y} w=${b.width} h=${b.height}`);
  }
  if (m.region) {
    const g = m.region;
    lines.push(`- **Region:** x=${g.x} y=${g.y} w=${g.width} h=${g.height} (page coordinates, inside the element above)`);
  }
  if (m.styles) lines.push(`- **Styles:** \`${esc(m.styles)}\``);
  lines.push(`- **Tag:** \`${esc(a.tag)}\`: ${TAG_MEANINGS[a.tag]}`);
  return lines.join("\n");
}

export function buildBrief(items: BriefItem[], page: { url: string; title: string }): string {
  const out = [
    "# Annotate Export",
    "",
    `**URL:** ${page.url || "unknown"}`,
    `**Title:** ${page.title ? esc(page.title) : "unknown"}`,
    `**Items:** ${items.length}`,
    "",
  ];
  items.forEach((a, i) => {
    out.push(one(a, i), "", "---", "");
  });
  return out.join("\n");
}
