// Which run the arena is showing, kept in the address so a reload, a shared link or the back
// button lands on the same run.
//
// A query parameter beside `entry`, the panel's one other piece of address state, rather than a
// path: the panel is served from one path, and `entry` already says which tab a reload opens on.
// No `run` is the new-run form.

const RUN_PARAM = "run";
/** The ids the sidecar hands out; a hand-edited value must not reach a request path. */
const RUN_ID = /^[a-z0-9-]{1,64}$/i;

/** The run an address names, or null for one that names none or a value no run could have. */
export function runInAddress(search: string): string | null {
  const asked = new URLSearchParams(search).get(RUN_PARAM);
  return asked !== null && RUN_ID.test(asked) ? asked : null;
}

/** The same address, naming `runId`, or naming no run; everything else in it kept. */
export function addressWithRun(href: string, runId: string | null): string {
  const url = new URL(href);
  if (runId === null) url.searchParams.delete(RUN_PARAM);
  else url.searchParams.set(RUN_PARAM, runId);
  return url.toString();
}
