/* Panel styles, scoped to the shadow root. Direction: a compact utility
 * palette floating over arbitrary pages; solid surfaces so it always reads as
 * separate from the page beneath. Colors are tokens; tags map to semantic
 * colors (bug, suggestion, question). */
export const PANEL_CSS = `
:host { all: initial; }
.root {
  color-scheme: light dark;
  --surface: oklch(0.99 0 0);
  --surface-2: oklch(0.955 0 0);
  --surface-hover: oklch(0.93 0 0);
  --surface-press: oklch(0.89 0 0);
  --ink: oklch(0.22 0 0);
  --ink-2: oklch(0.44 0 0);
  --hint: oklch(0.56 0 0);
  --border: oklch(0.87 0 0);
  --accent: oklch(0.55 0.19 255);
  --accent-ink: oklch(0.99 0 0);
  --focus: oklch(0.62 0.19 255);
  --danger: oklch(0.55 0.2 27);
  --ok: oklch(0.58 0.15 150);
  --warn: oklch(0.68 0.15 70);
  --tag-bug: oklch(0.62 0.21 27);
  --tag-suggestion: oklch(0.66 0.16 150);
  --tag-question: oklch(0.78 0.15 85);
  --shadow: 0 6px 24px oklch(0 0 0 / 0.22);
  --radius: 10px;
  --radius-sm: 6px;
  --dur: 120ms;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  font: 12px/1.45 var(--sans);
  color: var(--ink);
}
@media (prefers-color-scheme: dark) {
  .root {
    --surface: oklch(0.23 0 0);
    --surface-2: oklch(0.27 0 0);
    --surface-hover: oklch(0.31 0 0);
    --surface-press: oklch(0.36 0 0);
    --ink: oklch(0.96 0 0);
    --ink-2: oklch(0.78 0 0);
    --hint: oklch(0.66 0 0);
    --border: oklch(0.38 0 0);
    --accent: oklch(0.66 0.17 255);
    --accent-ink: oklch(0.16 0 0);
    --focus: oklch(0.72 0.16 255);
  }
}
@media (prefers-reduced-motion: reduce) { .root { --dur: 0ms; } }

.dock { position: fixed; z-index: 2147483647; top: 12px; right: 12px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.dock[hidden], .list[hidden] { display: none; }
.bar, .list, .form { background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); box-sizing: border-box; }
.form { position: fixed; z-index: 2147483647; }
.bar { max-width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 5px 5px 5px 10px; border-radius: 12px; }
.bar .title { font-weight: 600; margin-right: 2px; }
.count { min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--surface-2); color: var(--ink); text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hint); margin: 0 4px; }
.dot[data-status="connected"] { background: var(--ok); }
.dot[data-status="offline"] { background: var(--danger); }
.dot[data-status="signed-out"] { background: var(--warn); }
.sep { width: 1px; align-self: stretch; background: var(--border); margin: 2px 2px; }

button { font: inherit; color: inherit; cursor: pointer; border: 1px solid transparent; background: transparent; border-radius: var(--radius-sm);
  transition: background-color var(--dur), border-color var(--dur), color var(--dur); }
button:hover:not(:disabled) { background: var(--surface-hover); }
button:active:not(:disabled) { background: var(--surface-press); }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
button:disabled { cursor: not-allowed; color: var(--hint); }
button[aria-busy="true"] { cursor: progress; }
.icon-btn { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; color: var(--ink-2); }
.icon-btn:hover:not(:disabled) { color: var(--ink); }
.icon-btn.danger:hover:not(:disabled) { color: var(--danger); }
.text-btn { height: 26px; padding: 0 9px; border-color: var(--border); }
.text-btn[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.text-btn[aria-pressed="true"]:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.modes { display: inline-flex; }
.modes .text-btn { border-radius: 0; margin-left: -1px; }
.modes .text-btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); margin-left: 0; }
.modes .text-btn:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.modes .text-btn:focus-visible { position: relative; z-index: 1; }
.primary { height: 28px; padding: 0 14px; background: var(--accent); color: var(--accent-ink); font-weight: 600; }
.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.primary:active:not(:disabled) { background: var(--accent); filter: brightness(0.94); }
.primary:disabled { background: var(--surface-2); color: var(--hint); }
.ghost { height: 28px; padding: 0 12px; border-color: var(--border); }

.list { width: min(320px, 100%); min-height: 0; max-height: 60vh; overflow: auto; border-radius: var(--radius); padding: 4px; }
.banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin: 2px; border-radius: var(--radius-sm); background: var(--surface-2); }
.banner span { flex: 1; }
.empty { padding: 10px; color: var(--hint); }
.item { padding: 7px 8px 7px 10px; margin: 2px; border-radius: var(--radius-sm); border-left: 3px solid var(--tag-bug); cursor: pointer; }
.item:hover { background: var(--surface-2); }
.item[data-tag="suggestion"] { border-left-color: var(--tag-suggestion); }
.item[data-tag="question"] { border-left-color: var(--tag-question); }
.row { display: flex; align-items: flex-start; gap: 2px; }
.label { flex: 1; padding-top: 4px; overflow-wrap: anywhere; }
.item.resolved .label .text { text-decoration: line-through; color: var(--ink-2); }
.meta { color: var(--ink-2); font-size: 11px; }
.reply { margin: 2px 0 2px 14px; font-size: 11px; }
.reply .by { color: var(--ink-2); }
.item-error { margin: 2px 0 0 14px; color: var(--danger); font-size: 11px; }
.thumb { display: block; width: 128px; margin: 4px 0 2px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); cursor: zoom-in; }
.replybox { display: flex; gap: 4px; margin: 4px 0 2px 14px; }
.replybox input { flex: 1; min-width: 0; font: inherit; color: var(--ink); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 7px; }
.replybox input:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }

.form { left: 50%; top: 16%; transform: translateX(-50%); width: 380px; max-width: calc(100vw - 24px); box-sizing: border-box; border-radius: 14px; padding: 14px; font-size: 13px; }
.form[hidden] { display: none; }
.form-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-weight: 600; }
.selector { font: 11px/1.5 var(--mono); color: var(--ink-2); margin-bottom: 8px; overflow-wrap: anywhere; max-height: 50px; overflow: hidden; }
textarea { width: 100%; box-sizing: border-box; font: 13px/1.5 var(--sans); color: var(--ink); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; resize: vertical; }
textarea:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
.form-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.form-row .spacer { flex: 1; }
.form-row .primary { margin-left: auto; }
select { font: 12px var(--sans); color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 6px; }
.form-error { margin-top: 8px; color: var(--danger); font-size: 12px; }
.form-error:empty { display: none; }

.light { position: fixed; inset: 0; z-index: 2147483647; background: oklch(0 0 0 / 0.8); display: grid; place-items: center; cursor: zoom-out; }
.light[hidden] { display: none; }
.light img { max-width: 92vw; max-height: 92vh; border-radius: 12px; }
`;
