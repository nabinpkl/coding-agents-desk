import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { applyBuiltModulePatch, builtModuleTargets } from './built-module-patch.mjs';

for (const target of builtModuleTargets) {
  const path = resolve(import.meta.dirname, '..', 'package', target);
  const originalSource = await readFile(path, 'utf8');
  const result = applyBuiltModulePatch(target, originalSource);
  if (result.changed) {
    throw new Error(
      `${target}: generated xterm module is not patched; `
      + 'run terminal/vendor/xterm/scripts/update-built-module.mjs explicitly',
    );
  }
}

console.log('check-built-module: audited xterm modules are patched');
