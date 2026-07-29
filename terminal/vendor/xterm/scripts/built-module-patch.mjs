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
    already: [
      'get onUserData(){return this._core.onUserData}',
      'get onUserData(){return this._core.coreService.onUserData}',
    ],
    pattern: /get onData\(\)\{return this\._core\.onData\}get onKey\(\)/,
    replacement: 'get onData(){return this._core.onData}get onUserData(){return this._core.coreService.onUserData}get onKey()',
  },
];

export const builtModuleTargets = ['lib/xterm.mjs', 'lib/xterm.js'];

export function applyBuiltModulePatch(target, originalSource) {
  let source = originalSource;
  for (const replacement of replacements) {
    const already = Array.isArray(replacement.already) ? replacement.already : [replacement.already];
    if (already.some(marker => source.includes(marker))) continue;
    const occurrences = [...source.matchAll(new RegExp(replacement.pattern.source, 'g'))].length;
    if (occurrences !== 1) {
      throw new Error(`${target}: expected one patch occurrence, found ${occurrences}`);
    }
    source = source.replace(replacement.pattern, replacement.replacement);
  }
  return {
    source,
    changed: source !== originalSource,
  };
}
