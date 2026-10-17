/** One or two letters for a row with no room for the name; the hue still says which. */
const SHORT_LABELS: Record<string, string> = { claude: "C", opencode: "O", codex: "Cx", pi: "Pi" };

export function SourceBadge({ source, short = false }: { source: string; short?: boolean }) {
  const label = source === "claude" ? "Claude" : source === "codex" ? "Codex" : source === "pi" ? "Pi" : source === "opencode" ? "OpenCode" : source;
  const shown = short ? (SHORT_LABELS[source] ?? label) : label;
  const cls =
    source === "claude"
      ? "bg-violet-500/20 text-violet-500 dark:text-violet-400"
      : source === "codex"
        ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
        : source === "pi"
          ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-400"
          : source === "opencode"
            ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
            : "bg-muted text-muted-foreground";
  return (
    <span
      aria-label={`Source: ${label}`}
      // `font-medium`, not semibold. This badge is metadata about a row -- which provider the
      // session belongs to -- and it was the heaviest thing in that row: 11px but bold, uppercase,
      // monospaced, tracked out, on a saturated fill, against a 13px title. Every one of those is
      // an emphasis signal and they stack, so the label about the session was winning the eye
      // ahead of the session's own name. One step of weight is all it takes to put them back in
      // order, and the hue still does the job the badge exists for.
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium uppercase tracking-wide ${cls}`}
    >
      {shown}
    </span>
  );
}
