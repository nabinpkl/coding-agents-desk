export function SourceBadge({ source }: { source: string }) {
  const label = source === "claude" ? "Claude" : source === "codex" ? "Codex" : source === "pi" ? "Pi" : source;
  const cls =
    source === "claude"
      ? "bg-violet-500/20 text-violet-500 dark:text-violet-400"
      : source === "codex"
        ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
        : source === "pi"
          ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-400"
          : "bg-muted text-muted-foreground";
  return (
    <span
      aria-label={`Source: ${label}`}
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}
