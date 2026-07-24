import { readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { build } from 'esbuild';

export async function buildGeneratedTerminalWeb(outputDirectory, logicalOutputDirectory) {
  const output = resolve(outputDirectory);
  const webRoot = resolve(import.meta.dirname, '..');
  const existingEntries = await readdir(output);
  if (existingEntries.length !== 0) {
    throw new Error(`terminal web staging directory must be empty: ${output}`);
  }

  const result = await build({
    absWorkingDir: webRoot,
    bundle: true,
    entryPoints: ['src/main.js'],
    external: ['agentdesk-terminal://*'],
    format: 'iife',
    logLevel: 'info',
    minify: true,
    outfile: resolve(logicalOutputDirectory, 'app.js'),
    sourcemap: true,
    write: false,
  });

  const expectedFiles = new Set(['app.js', 'app.js.map', 'app.css', 'app.css.map']);
  for (const generatedFile of result.outputFiles) {
    const file = basename(generatedFile.path);
    if (!expectedFiles.delete(file)) {
      throw new Error(`unexpected terminal web output: ${generatedFile.path}`);
    }
    await writeFile(resolve(output, file), generatedFile.contents);
  }
  if (expectedFiles.size !== 0) {
    throw new Error(`missing terminal web outputs: ${[...expectedFiles].join(', ')}`);
  }
}

const [outputDirectory, logicalOutputDirectory, ...unexpected] = process.argv.slice(2);
if (!outputDirectory || !logicalOutputDirectory || unexpected.length !== 0) {
  throw new Error(
    'usage: build-generated.mjs <empty-staging-directory> <logical-output-directory>',
  );
}
await buildGeneratedTerminalWeb(outputDirectory, logicalOutputDirectory);
