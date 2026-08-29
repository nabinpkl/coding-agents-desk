import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("voice source builds constrain Cython during metadata preparation and wheel compilation", async () => {
  const script = await readFile(new URL("./build-voice-wheelhouse.sh", import.meta.url), "utf8");
  const constraints = await readFile(new URL("./voice-build-constraints.txt", import.meta.url), "utf8");
  assert.match(constraints, /^Cython==3\.2\.9$/m);
  for (const command of ["download", "wheel"]) {
    const invocation = script.split(`"$DOWNLOADER/bin/pip" ${command} \\\n`)[1]?.split("\n\n")[0];
    assert.ok(invocation, `missing pip ${command} invocation`);
    assert.ok(invocation.includes('--build-constraint "$BUILD_CONSTRAINTS"'), command);
  }
});

test("voice staging hash includes build constraints so pin changes cannot reuse stale wheels", async () => {
  const justfile = await readFile(new URL("../../Justfile", import.meta.url), "utf8");
  const recipe = justfile.split("\nbuild-voice-sidecar:\n")[1]?.split("\n\n")[0];
  assert.ok(recipe);
  assert.match(recipe, /WHEELHOUSE_CONSTRAINTS='.*\/tools\/build-system\/voice-build-constraints\.txt'/);
  assert.match(recipe, /HASH=.*"\$WHEELHOUSE_CONSTRAINTS"/);
});
