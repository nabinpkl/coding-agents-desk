"use client";

import { useEffect } from "react";
import { create } from "zustand";

// Locked discrete steps so persisted values can be validated against the
// same set rather than a free range.
export const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36] as const;
type FontSize = (typeof FONT_SIZE_OPTIONS)[number];

// Token taxonomy is hierarchical so the settings modal can render one tab
// per "tab" value, with subgrouping by "section" inside the canvas tab.
export type FontTokenKey =
  | "sidebar_title"
  | "sidebar_body"
  | "sidebar_meta"
  | "sidebar_chip"
  | "canvas_menu"
  | "tile_chip"
  | "tile_diff"
  | "tile_other_text"
  | "tile_reasoning";

export type FontTab = "sidebar" | "canvas";
export type CanvasSection = "menus" | "tiles";

export interface FontTokenSpec {
  key: FontTokenKey;
  label: string;
  description: string;
  cssVar: string;
  defaultPx: number;
  tab: FontTab;
  section?: CanvasSection; // applies only when tab === "canvas"
  group?: string;          // optional sub-header within a section
}

// Every `defaultPx` below is also written as the literal fallback in each
// consumer's `text-(length:--var,Npx)`, which is what the window renders in the
// frame before `FontSizeRoot` sets the variables. The two must agree.
//
// The sidebar tokens carried defaults nobody had ever seen: the whole list and
// footer were hardcoded Tailwind sizes, so these five tokens had no consumer at
// all and their tab moved nothing. Wiring them up used the sizes already on
// screen as the defaults rather than the numbers that had been sitting here, so
// that connecting the control did not silently restyle the panel.
export const FONT_TOKENS: readonly FontTokenSpec[] = [
  // Sidebar
  {
    key: "sidebar_title",
    label: "Title",
    description: "Panel header title (\"Agent Feed\", then project, then session)",
    cssVar: "--agent-panel-fs-sidebar-title",
    defaultPx: 15,
    tab: "sidebar",
  },
  {
    key: "sidebar_body",
    label: "Item text",
    description: "Project and session names in each row, and empty-state text",
    cssVar: "--agent-panel-fs-sidebar-body",
    defaultPx: 15,
    tab: "sidebar",
  },
  {
    key: "sidebar_meta",
    label: "Meta",
    description: "Session count, timestamp, retry notice, footer captions",
    cssVar: "--agent-panel-fs-sidebar-meta",
    defaultPx: 13,
    tab: "sidebar",
  },
  {
    key: "sidebar_chip",
    label: "Chip",
    description: "Source badge (CLAUDE / CODEX)",
    cssVar: "--agent-panel-fs-sidebar-chip",
    defaultPx: 11,
    tab: "sidebar",
  },
  // Canvas: menus (canvas chrome, top toolbar, status, modal)
  {
    key: "canvas_menu",
    label: "Menus & status",
    description: "Feed status lines: loading, error, and empty",
    cssVar: "--agent-panel-fs-canvas-menu",
    defaultPx: 13,
    tab: "canvas",
    section: "menus",
  },
  // Canvas: tiles (the transcript feed's own content)
  //
  // `tile_heading` and `tile_subheading` used to sit here and `tile_terminal`
  // below, all three inert. They named the per-agent canvas of tiles from
  // `mock-design/`, which AGENTS.md places at v1+ -- this panel is a header, a
  // list, and a feed, and has no tile titles or tab labels to size. The
  // terminal one was doubly misleading: the Agents window's terminal font is
  // real, but it is driven by the window zoom chord through
  // `PtyTerminalWebView`, not from here. Prose headings inside a message are
  // deliberately NOT a token; they are `em` off `tile_other_text` so they
  // track the body (see markdown.css).
  {
    key: "tile_chip",
    label: "Chip",
    description: "Role chips (USER, ASSISTANT, TOOL, RESULT), index, timestamps, feed toolbar",
    cssVar: "--agent-panel-fs-tile-chip",
    defaultPx: 12,
    tab: "canvas",
    section: "tiles",
    group: "Body",
  },
  {
    key: "tile_diff",
    label: "Diff",
    description: "Diff code lines and the file-path strip above each diff",
    cssVar: "--agent-panel-fs-tile-diff",
    defaultPx: 14,
    tab: "canvas",
    section: "tiles",
    group: "Body",
  },
  {
    key: "tile_other_text",
    label: "Other text",
    description: "User and assistant message bodies, tool labels, observer text",
    cssVar: "--agent-panel-fs-tile-other-text",
    // 14 read small next to other agent transcript UIs. Measured against a
    // side-by-side of the same paragraph, theirs fit ~79 characters per line
    // where this fit ~98, which is a ~1.24x size difference, not a weight or
    // typeface one. Nothing renders these controls yet, so this default IS the
    // rendered size for everyone -- `readInitial` only prefers a stored value,
    // and no code path writes one.
    defaultPx: 16,
    tab: "canvas",
    section: "tiles",
    group: "Body",
  },
  {
    key: "tile_reasoning",
    label: "Reasoning",
    description: "Codex reasoning rows (model's internal thought trace)",
    cssVar: "--agent-panel-fs-tile-reasoning",
    // Tracks `tile_other_text` one step down, which is what makes the trace
    // read as commentary. Moving one without the other collapses that.
    defaultPx: 14,
    tab: "canvas",
    section: "tiles",
    group: "Body",
  },
];

const STORAGE_KEY = "agent-panel.font.tokens";
const DEFAULT_TOKENS: Record<FontTokenKey, number> = Object.fromEntries(
  FONT_TOKENS.map((t) => [t.key, t.defaultPx]),
) as Record<FontTokenKey, number>;

interface FontStore {
  tokens: Record<FontTokenKey, number>;
  setToken: (k: FontTokenKey, n: number) => void;
  resetAll: () => void;
}

function readInitial(): Record<FontTokenKey, number> {
  if (typeof window === "undefined") return DEFAULT_TOKENS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TOKENS;
    const parsed = JSON.parse(raw) as Partial<Record<FontTokenKey, number>>;
    const out = { ...DEFAULT_TOKENS };
    for (const t of FONT_TOKENS) {
      const v = parsed[t.key];
      if (typeof v === "number" && (FONT_SIZE_OPTIONS as readonly number[]).includes(v)) {
        out[t.key] = v;
      }
    }
    return out;
  } catch {
    return DEFAULT_TOKENS;
  }
}

function persist(tokens: Record<FontTokenKey, number>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens)); } catch { /* storage disabled */ }
}

export const useFontStore = create<FontStore>((set, get) => ({
  tokens: readInitial(),
  setToken: (k, n) => {
    const next = { ...get().tokens, [k]: n as FontSize };
    set({ tokens: next });
    persist(next);
  },
  resetAll: () => {
    set({ tokens: { ...DEFAULT_TOKENS } });
    persist(DEFAULT_TOKENS);
  },
}));

// Mount once at app root: pushes each chosen token into a CSS variable on
// <html> so every consumer can read its variable without prop drilling.
export function FontSizeRoot() {
  const tokens = useFontStore((s) => s.tokens);
  useEffect(() => {
    const root = document.documentElement;
    for (const t of FONT_TOKENS) {
      root.style.setProperty(t.cssVar, `${tokens[t.key]}px`);
    }
  }, [tokens]);
  return null;
}
