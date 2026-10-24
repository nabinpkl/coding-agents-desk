#!/usr/bin/env bash
# Tells this machine's sidecar which agent log the calling session keeps (ADR-0147), so the
# session's card shows a button that opens it.
#
#   tools/agent-log-register.sh .agents/agents-log/<area>-manager.log
#   tools/agent-log-register.sh --session claude:<session id> .agents/agents-log/<area>-manager.log
#
# Run it after appending a line to a log. Repeating it is safe: a second call for the same log
# changes nothing. The session is `$CLAUDE_CODE_SESSION_ID`, which every Claude session carries.
# `--session` names one explicitly, for registering a log for a session that cannot run this
# itself: a backfill, or an opencode session.
#
# The sidecar is found through its rendezvous file, `<registry>/<user>.json`, which it rewrites
# every 5 seconds, and a file older than 15 seconds (the panel's `SIDECAR_STALE_MS`) counts as no
# sidecar. Not through `AGENT_FEED_HOST` and `AGENT_FEED_PORT`: sessions inherit those from the
# tmux server's environment, copied once when that server started, so they can be absent or stale.
#
# Exits non-zero with the reason when nothing was registered. The log line itself is unaffected:
# say that registration failed, and the next write tries again.
set -euo pipefail

usage() {
  echo "usage: $0 [--session <source>:<session id>] .agents/agents-log/<name>.log" >&2
  exit 2
}

session=""
if [[ "${1:-}" == "--session" ]]; then
  [[ $# -ge 2 ]] || usage
  session="$2"
  shift 2
fi
[[ $# -eq 1 ]] || usage
log_path="$1"

if [[ -z "$session" ]]; then
  if [[ -z "${CLAUDE_CODE_SESSION_ID:-}" ]]; then
    echo "agent-log-register: CLAUDE_CODE_SESSION_ID is not set; name the session with --session <source>:<id>" >&2
    exit 1
  fi
  session="claude:${CLAUDE_CODE_SESSION_ID}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
registry="$(node "$repo_root/tools/runtime-paths.mjs" sidecar-registry)"

# Every value travels as an argument, never inside the script text.
exec node --input-type=module -e '
const [registry, user, session, logPath] = process.argv.slice(1);
const STALE_MS = 15_000;
const fail = (message) => {
  console.error(`agent-log-register: ${message}`);
  process.exit(1);
};
const colon = session.indexOf(":");
if (colon <= 0 || colon === session.length - 1) fail(`--session must be <source>:<session id>, got "${session}"`);
const source = session.slice(0, colon);
const sessionId = session.slice(colon + 1);

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

const url = `http://${descriptor.host}:${descriptor.port}/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(sessionId)}/log`;
let response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: logPath }),
    signal: AbortSignal.timeout(5_000),
  });
} catch (error) {
  fail(`the sidecar at ${descriptor.host}:${descriptor.port} did not answer: ${error.cause?.code ?? error.cause?.errors?.[0]?.code ?? error.cause?.message ?? error.message}`);
}
const answer = await response.json().catch(() => null);
if (!response.ok) fail(`not registered (${response.status}): ${answer?.error?.message ?? "no reason given"}`);
console.log(`${answer.status === "already" ? "already registered" : "registered"}: ${answer.path} for ${session} on Bot ${answer.botId}`);
' -- "$registry" "$(id -un)" "$session" "$log_path"
