import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { applyBuiltModulePatch, builtModuleTargets } from './built-module-patch.mjs';

let updated = 0;
for (const target of builtModuleTargets) {
  const path = resolve(import.meta.dirname, '..', 'package', target);
  const originalSource = await readFile(path, 'utf8');
  const result = applyBuiltModulePatch(target, originalSource);
  if (!result.changed) continue;
  await writeFile(path, result.source);
  updated += 1;
}

console.log(`update-built-module: updated=${updated}`);
