#!/usr/bin/env bash
# A disposable Claude session to probe against, on the cheapest model that can hold a context.
#
# Every verification this repo does against a REAL session -- does a compaction show, does the
# mirror bind a flow, does the panel draw a row -- needs a session that is not the owner's. Three
# agents built that by hand in one evening and each rediscovered the same four traps, so it lives
# here instead:
#
#   - The model is Haiku unless you say otherwise, and the effort is low. A probe session exists to
#     produce transcript records and API flows, not answers. The one that prompted this script ran
#     on the same Opus the real work uses and spent it saying the word "acorn".
#   - The session id is CHOSEN, with `--session-id`, and printed. Otherwise the caller has to find
#     the transcript afterwards by grepping `~/.claude/projects` for its title, which is a race
#     against every other session starting at the same moment.
#   - No tools, via `--disallowedTools`. An interactive session cannot be asked a permission
#     question by a script: the prompt appears in the pane and the probe hangs there forever. This
#     is not a sandbox -- it is a session that has nothing to ask about. `--tools` widens it when a
#     probe genuinely needs one, and then the caller owns answering.
#   - `tmux send-keys -l` silently drops a long string, so `say` chunks it and sends Enter as its
#     own call. Same rule as the one in AGENTS.md, implemented once.
#
# It runs as the console user in tmux, like all work here. It is a probe, not a worker: nothing
# reads its output but you.
#
#   id=$(tools/throwaway-session.sh start probe)      # prints the session uuid
#   tools/throwaway-session.sh say probe 'Reply with exactly the word: alder'
#   tools/throwaway-session.sh say probe /compact
#   tools/throwaway-session.sh pane probe
#   tools/throwaway-session.sh stop probe
set -euo pipefail

MODEL="${THROWAWAY_MODEL:-claude-haiku-4-5-20251001}"
EFFORT="${THROWAWAY_EFFORT:-low}"
# The repo by default, so the session appears in the panel under the project being worked on and
# comes up with a context big enough to be worth compacting. Point it elsewhere for a probe that
# wants to start small.
DIR="${THROWAWAY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Everything a probe could be asked to approve. Widen with THROWAWAY_TOOLS='' and answer the pane
# yourself, or with a specific list.
TOOLS="${THROWAWAY_TOOLS:-Bash Edit Write Read Glob Grep Agent Task WebFetch WebSearch NotebookEdit}"
READY_TIMEOUT="${THROWAWAY_READY_TIMEOUT:-60}"

usage() {
  echo "usage: $(basename "$0") start|say|pane|stop <name> [text]" >&2
  exit 64
}

[ $# -ge 2 ] || usage
verb="$1"
name="$2"
: "${name:?a tmux session name is required}"

case "$verb" in
  start)
    if tmux has-session -t "$name" 2>/dev/null; then
      echo "throwaway-session: $name is already running" >&2
      exit 1
    fi
    id="$(uuidgen | tr 'A-Z' 'a-z')"
    args=(claude --model "$MODEL" --effort "$EFFORT" --session-id "$id" -n "$name" --strict-mcp-config)
    [ -n "$TOOLS" ] && args+=(--disallowedTools "$TOOLS")
    # One argument per array element, quoted by tmux's own `--` handling rather than by a string
    # this script assembles: a name with a space in it is what broke the last hand-rolled one.
    tmux new-session -d -s "$name" -c "$DIR" "${args[@]}"
    # Ready means the transcript exists: the session has registered and will answer a prompt. The
    # pane's own prompt character appears earlier, while plugins are still loading.
    slug="$(echo "$DIR" | sed 's#/#-#g')"
    transcript="$HOME/.claude/projects/$slug/$id.jsonl"
    waited=0
    while [ ! -f "$transcript" ] && [ "$waited" -lt "$READY_TIMEOUT" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if [ ! -f "$transcript" ]; then
      echo "throwaway-session: $name did not register within ${READY_TIMEOUT}s" >&2
      tmux capture-pane -p -t "$name" | tail -12 >&2
      exit 1
    fi
    echo "$id"
    ;;
  say)
    [ $# -ge 3 ] || usage
    shift 2
    text="$*"
    # ~300 characters at a time, because `send-keys -l` drops a long one with no error: 2,600
    # characters once produced an empty composer and a silent probe.
    while [ -n "$text" ]; do
      tmux send-keys -l -t "$name" -- "${text:0:300}"
      text="${text:300}"
      sleep 0.15
    done
    sleep 0.5
    tmux send-keys -t "$name" Enter
    ;;
  pane)
    tmux capture-pane -p -t "$name"
    ;;
  stop)
    tmux kill-session -t "$name" 2>/dev/null || true
    ;;
  *)
    usage
    ;;
esac
