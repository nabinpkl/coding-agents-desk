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
#   - No tools, via `--tools ""`, and no browser, via `--no-chrome`. An interactive session cannot be asked a permission question by
#     a script: the prompt appears in the pane and the probe hangs there forever. This is not a
#     sandbox -- it is a session that has nothing to ask about. `THROWAWAY_TOOLS` names the ones a
#     probe genuinely needs, and then the caller owns answering. An allow list rather than the
#     deny list this used to carry, which went stale: a probe asked to say one word answered by
#     calling a tool the list had never heard of.
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
# The built-in tools the probe may use: none unless named, e.g. THROWAWAY_TOOLS='Read,Bash'.
TOOLS="${THROWAWAY_TOOLS:-}"
READY_TIMEOUT="${THROWAWAY_READY_TIMEOUT:-60}"
# `off` starts the session around proxy-agent rather than through it, so the live mirror never sees
# its traffic and the panel has only the transcript and the pane -- what a turn looks like when the
# capture drops mid-response. tmux hands every pane its server's global proxy variables, so they are
# unset on the command itself rather than in this script's environment.
PROXY="${THROWAWAY_PROXY:-on}"
# Plugin directories to load for this session only, colon-separated, each passed as `--plugin-dir`.
# This is how a probe tries a mod: it loads without being installed, and nothing is written under
# ~/.claude. Earlier entries are passed first.
PLUGIN_DIRS="${THROWAWAY_PLUGIN_DIRS:-}"
# One MCP config file for this session, passed as `--mcp-config`. The session is started with
# `--strict-mcp-config`, so without this it has no MCP servers at all, not even the project's own
# `.mcp.json`: a probe that has to send or answer hub messages names the relay here.
MCP_CONFIG="${THROWAWAY_MCP_CONFIG:-}"

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
    args+=(--tools "$TOOLS")
    if [ -n "$MCP_CONFIG" ]; then
      args+=(--mcp-config "$MCP_CONFIG")
    fi
    # `--tools ""` does not reach the Claude in Chrome integration: measured 2026-10-16, a probe
    # with no tools answered its first message by calling read_page on the owner's browser.
    args+=(--no-chrome)
    if [ -n "$PLUGIN_DIRS" ]; then
      IFS=: read -r -a plugin_dirs <<<"$PLUGIN_DIRS"
      for plugin_dir in "${plugin_dirs[@]}"; do
        args+=(--plugin-dir "$plugin_dir")
      done
    fi
    if [ "$PROXY" = off ]; then
      args=(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy "${args[@]}")
    fi
    # One argument per array element, quoted by tmux's own `--` handling rather than by a string
    # this script assembles: a name with a space in it is what broke the last hand-rolled one.
    tmux new-session -d -s "$name" -c "$DIR" "${args[@]}"
    # Ready means the session has REGISTERED: its record under ~/.claude/sessions names this id.
    # Not the transcript, which the CLI no longer writes until the first prompt arrives (measured
    # 2026-10-05 on 2.1.x: a session sat at its prompt for a minute with no transcript, and every
    # start here timed out while the session was up). Not the pane's prompt character either, which
    # is drawn while plugins are still loading. Read-only: nothing here writes under ~/.claude.
    sessions="${THROWAWAY_SESSIONS_DIR:-$HOME/.claude/sessions}"
    waited=0
    until grep -lqs "\"sessionId\": *\"$id\"" "$sessions"/*.json; do
      if [ "$waited" -ge "$READY_TIMEOUT" ]; then
        echo "throwaway-session: $name did not register within ${READY_TIMEOUT}s" >&2
        tmux capture-pane -p -t "$name" | tail -12 >&2
        exit 1
      fi
      sleep 1
      waited=$((waited + 1))
    done
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
    # Said out loud rather than ignored: adding a session to a Bot renames its tmux session (to
    # "<first-name>-<name>", measured 2026-10-16), and a stop that quietly found nothing left a probe
    # running unnoticed while this exited 0.
    if ! tmux has-session -t "$name" 2>/dev/null; then
      echo "throwaway-session: no tmux session named $name; if it joined a Bot it was renamed (tmux ls)" >&2
      exit 1
    fi
    tmux kill-session -t "$name"
    ;;
  *)
    usage
    ;;
esac
