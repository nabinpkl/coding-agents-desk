import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const targets = ['lib/xterm.mjs', 'lib/xterm.js'];

const replacements = [
  {
    already: 'this.onUserData=this._onUserData.event',
    pattern: /this\._onData=this\._register\(new ([\w.]+)\)[;,]this\.onData=this\._onData\.event[;,]this\._onUserInput=/,
    replacement: (_, emitter) => `this._onData=this._register(new ${emitter});this.onData=this._onData.event;this._onUserData=this._register(new ${emitter});this.onUserData=this._onUserData.event;this._onUserInput=`,
  },
  {
    already: '_onUserData.fire(e)',
    pattern: /([a-zA-Z_$][\w$]*)&&this\._onUserInput\.fire\(\)[;,]this\._logService\.debug/,
    replacement: (_, flag) => `${flag}&&(this._onUserInput.fire(),this._onUserData.fire(e)),this._logService.debug`,
  },
  {
    already: 'get onUserData(){return this._core.coreService.onUserData}',
    pattern: /get onData\(\)\{return this\._core\.onData\}get onKey\(\)/,
    replacement: 'get onData(){return this._core.onData}get onUserData(){return this._core.coreService.onUserData}get onKey()',
  },
];

for (const target of targets) {
  const path = resolve(import.meta.dirname, '..', 'package', target);
  let source = await readFile(path, 'utf8');
  for (const replacement of replacements) {
    if (source.includes(replacement.already)) continue;
    const occurrences = [...source.matchAll(new RegExp(replacement.pattern.source, 'g'))].length;
    if (occurrences !== 1) {
      throw new Error(`${target}: expected one occurrence, found ${occurrences}`);
    }
    source = source.replace(replacement.pattern, replacement.replacement);
  }
  await writeFile(path, source);
}
