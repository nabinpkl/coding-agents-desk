// The xterm grid paints its own cells, so `prefers-color-scheme` in terminal.css cannot reach it.
// These are the cell-level counterparts of the stylesheet's two schemes -- One Dark and One Light --
// and each `background` is the scheme's `--surface` token exactly, because the grid sits directly on
// `.terminal-canvas` and any drift between the two shows as a seam around the scaled viewport.
const darkTheme = Object.freeze({
  background: '#0b0e14', foreground: '#d8dee9', cursor: '#a8c7fa',
  selectionBackground: '#45658d99', black: '#1b1d23', red: '#e06c75',
  green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd',
  cyan: '#56b6c2', white: '#d4d7dd',
});

const lightTheme = Object.freeze({
  background: '#ffffff', foreground: '#2a2f38', cursor: '#2a6fdb',
  selectionBackground: '#b6d2ff80', black: '#383a42', red: '#d13b30',
  green: '#3f8f3c', yellow: '#9a6a00', blue: '#2a6fdb', magenta: '#9b2bb0',
  cyan: '#0a7d8c', white: '#a0a1a7',
});

export function prefersDarkScheme() {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function terminalTheme(dark = prefersDarkScheme()) {
  return dark ? darkTheme : lightTheme;
}

export function terminalOptions() {
  return {
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: '"AgentDesk Terminal", monospace',
    fontSize: 14,
    lineHeight: 1.08,
    scrollback: 2000,
    theme: terminalTheme(),
  };
}
