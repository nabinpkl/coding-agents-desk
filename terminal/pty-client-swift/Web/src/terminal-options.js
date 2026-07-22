export function terminalOptions() {
  return {
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: '"AgentDesk Terminal", monospace',
    fontSize: 14,
    lineHeight: 1.08,
    scrollback: 2000,
    theme: {
      background: '#0b0e14', foreground: '#d8dee9', cursor: '#a8c7fa',
      selectionBackground: '#45658d99', black: '#1b1d23', red: '#e06c75',
      green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd',
      cyan: '#56b6c2', white: '#d4d7dd',
    },
  };
}
