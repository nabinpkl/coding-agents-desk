"use client";

import { useEffect, useState } from "react";
import { generateDiffFile } from "@git-diff-view/file";
import { DiffView, DiffModeEnum, type DiffFile } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useFontStore } from "@/features/activity-feed/reading-preferences/fontStore";

// Renders a unified diff for an Edit tool_use block. Uses the snippet (not
// the full file) since the harness records old_string/new_string only.
// Reads sufficiently for short edits which is the common case. No path bar:
// the row header already names the basename, so a full path here repeats it.
// filePath stays a prop because the grammar comes from the extension.
export function DiffBlock({
  filePath, oldString, newString,
}: {
  filePath: string;
  oldString: string;
  newString: string;
}) {
  const isDark = usePrefersDark();
  // Library renders code lines via canvas measurement, not CSS inheritance,
  // so the wrapper's font-size is ignored. Pass the token through directly.
  const diffPx = useFontStore((s) => s.tokens.tile_diff);
  const [file, setFile] = useState<DiffFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const lang = languageFromPath(filePath);
      const name = filePath.split("/").pop() ?? filePath;
      const f = generateDiffFile(name, oldString, name, newString, lang, lang);
      f.initTheme(isDark ? "dark" : "light");
      f.init();
      f.buildUnifiedDiffLines();
      setFile(f);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [filePath, oldString, newString, isDark]);

  if (error) {
    return (
      <div
        className="rounded-sm border border-destructive/40 bg-destructive/10 px-[0.55em] py-[0.4em] text-destructive"
        style={{ fontSize: "var(--agent-panel-fs-tile-diff, 14px)" }}
      >
        diff error: {error}
      </div>
    );
  }
  if (!file) return null;
  return (
    <div
      className="overflow-hidden rounded-sm border border-border/60"
      style={{ fontSize: "var(--agent-panel-fs-tile-diff, 14px)" }}
    >
      <DiffView
        diffFile={file}
        diffViewMode={DiffModeEnum.Unified}
        diffViewHighlight
        diffViewWrap
        diffViewTheme={isDark ? "dark" : "light"}
        diffViewFontSize={diffPx}
      />
    </div>
  );
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go",
  java: "java", kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", cc: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", php: "php", scala: "scala",
  json: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "scss",
  md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile",
};

export function languageFromPath(p: string): string {
  const base = (p.split("/").pop() ?? p).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] ?? "plaintext";
}

// The panel follows the OS appearance through a `prefers-color-scheme` media query
// (`app/styles.css`), with no JS theme provider mounted. next-themes' `useTheme`
// therefore always answered light here, painting light pink/green diffs on a dark
// feed. Read the same media query directly instead.
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = (): void => setDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return dark;
}
