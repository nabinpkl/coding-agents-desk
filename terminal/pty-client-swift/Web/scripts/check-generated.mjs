import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../Sources/PtyTerminalWebView/Resources/Web');
const [javascript, stylesheet, index] = await Promise.all([
  readFile(resolve(root, 'app.js'), 'utf8'),
  readFile(resolve(root, 'app.css'), 'utf8'),
  readFile(resolve(root, 'index.html'), 'utf8'),
]);
const requiredFiles = ['app.js.map', 'app.css.map', 'JetBrainsMonoNerdFontMono-Regular.ttf'];
await Promise.all(requiredFiles.map(async file => {
  const metadata = await stat(resolve(root, file));
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`missing generated resource: ${file}`);
}));

if (!javascript.includes('onUserData') || javascript.includes('._core?.coreService')) {
  throw new Error('generated terminal runtime does not use the audited user-input event');
}
if (!javascript.includes('terminal-workspace-root') || !javascript.includes('checkpointBegin')) {
  throw new Error('generated terminal runtime is missing workspace or checkpoint support');
}
if (!stylesheet.includes('container:terminal-workspace') || !stylesheet.includes('AgentDesk Terminal')) {
  throw new Error('generated terminal stylesheet is stale');
}
if (!index.includes("default-src 'none'") || !index.includes('agentdesk-terminal://bundle/app.js')) {
  throw new Error('terminal resource shell is missing its CSP or private runtime URL');
}
