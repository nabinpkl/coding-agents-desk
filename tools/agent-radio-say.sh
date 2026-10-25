#!/usr/bin/env bash
# Says something short on Agent Radio as the calling session, to whoever is listening on the phone:
# named the way the session's announcements are, in the voice its Bot gave it, after the "done"
# tone, in line with the announcements (`POST /api/speech/say`).
#
#   tools/agent-radio-say.sh 'The migration finished and three tables changed.'
#   tools/agent-radio-say.sh --session opencode:<session id> 'Tests are green.'
#   tools/agent-radio-say.sh --listening      # how many pages listen, before writing anything long
#
# `--listening` asks first, and changes nothing: it prints how many pages have the Mac's stream open
# and exits 0, or 3 when none does. A page counts while its stream is open, paused or not, so it
# says whether a message would be heard on a device, not that a person is there to hear it.
#
# The session is `$CLAUDE_CODE_SESSION_ID`, which every Claude session carries. `--session` names one
# explicitly, which an opencode session has to. At most 1,000 characters, about a minute of speech: a
# longer message is refused rather than cut, so nothing is half said.
#
# It returns once the message is said, which is about when it finishes playing, so one waiting behind
# other messages takes that long too; after five minutes it stops waiting, and the message may still
# be said. With nobody listening nothing is said and it exits 3, so a caller can tell that apart from
# a failure.
#
# Exits 0 when said, 3 when nobody is listening, 1 for anything else, with the reason, 2 for usage.
#
# The sidecar is found through its rendezvous file, as `tools/agent-log-register.sh` finds it, not
# through `AGENT_FEED_PORT`, which a session inherits from the tmux server and can be stale.
set -euo pipefail

usage() {
  echo "usage: $0 [--session <source>:<session id>] '<text to say>'" >&2
  echo "       $0 --listening" >&2
  exit 2
}

mode="say"
session=""
text=""
if [[ "${1:-}" == "--listening" ]]; then
  [[ $# -eq 1 ]] || usage
  mode="listening"
else
  if [[ "${1:-}" == "--session" ]]; then
    [[ $# -ge 2 ]] || usage
    session="$2"
    shift 2
  fi
  [[ $# -eq 1 && -n "$1" ]] || usage
  text="$1"
fi

if [[ "$mode" == "say" && -z "$session" ]]; then
  if [[ -z "${CLAUDE_CODE_SESSION_ID:-}" ]]; then
    echo "agent-radio-say: CLAUDE_CODE_SESSION_ID is not set; name the session with --session <source>:<id>" >&2
    exit 1
  fi
  session="claude:${CLAUDE_CODE_SESSION_ID}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
registry="$(node "$repo_root/tools/runtime-paths.mjs" sidecar-registry)"

# Every value travels as an argument, never inside the script text.
exec node --input-type=module -e '
const [registry, user, mode, session, text] = process.argv.slice(1);
const STALE_MS = 15_000;
const WAIT_MS = 5 * 60_000;
const fail = (message, code = 1) => {
  console.error(`agent-radio-say: ${message}`);
  process.exit(code);
};

const { readFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const descriptorPath = join(registry, `${user}.json`);
let descriptor;
try {
  descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
} catch (error) {
  fail(`no sidecar is running for ${user}: ${descriptorPath} could not be read (${error.code ?? error.message})`);
}
const age = Date.now() - Number(descriptor.heartbeat);
if (!(age <= STALE_MS)) fail(`no sidecar is running for ${user}: its heartbeat is ${Math.round(age / 1000)}s old`);
const sidecar = `http://${descriptor.host}:${descriptor.port}`;

if (mode === "listening") {
  let count;
  try {
    const response = await fetch(`${sidecar}/api/audio/listeners`, { signal: AbortSignal.timeout(5_000) });
    const answer = await response.json().catch(() => null);
    if (!response.ok || typeof answer?.listeners !== "number") {
      fail(`no count (${response.status}): ${answer?.error?.message ?? "no reason given"}`);
    }
    count = answer.listeners;
  } catch (error) {
    fail(`the sidecar at ${descriptor.host}:${descriptor.port} did not answer: ${error.cause?.code ?? error.cause?.message ?? error.message}`);
  }
  if (count === 0) fail("nobody is listening", 3);
  console.log(`${count} listening`);
  process.exit(0);
}

let response;
try {
  response = await fetch(`${sidecar}/api/speech/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text }),
    signal: AbortSignal.timeout(WAIT_MS),
  });
} catch (error) {
  if (error.name === "TimeoutError") fail("still waiting its turn after five minutes; it may still be said");
  fail(`the sidecar at ${descriptor.host}:${descriptor.port} did not answer: ${error.cause?.code ?? error.cause?.message ?? error.message}`);
}
const answer = await response.json().catch(() => null);
if (!response.ok) {
  const code = answer?.error?.code;
  fail(`not said (${response.status}${code ? ` ${code}` : ""}): ${answer?.error?.message ?? "no reason given"}`, code === "nobody_listening" ? 3 : 1);
}
const seconds = (answer.durationMs / 1000).toFixed(1);
console.log(`said as ${answer.speaker} in ${answer.voice ?? "the voice in use"}, ${seconds}s, to ${answer.listeners} listener(s)`);
' -- "$registry" "$(id -un)" "$mode" "$session" "$text"
