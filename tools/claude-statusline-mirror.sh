#!/usr/bin/env sh
# Leaves a copy of Claude Code's rate limits where the agent-feed sidecar can read them, then
# runs whatever statusline command was already configured, unchanged.
#
# Why this exists. The CLI hands its statusline command a JSON payload on stdin carrying
# `.rate_limits.five_hour.used_percentage` and `.rate_limits.seven_day.used_percentage`, taken
# from the last response rather than from a cache. That payload is the only place those numbers
# reliably appear outside the CLI's own process: the documented on-disk copy,
# `cachedUsageUtilization` in `~/.claude.json`, was absent entirely on this machine (2.1.273,
# 2026-09-15) and absent from every rotated backup of that file, while sessions ran all day.
#
# So the statusline, which is already handed the numbers several times a minute, writes them down
# on the way past. Nothing else in the panel can produce them.
#
# Install it by pointing `statusLine.command` in `~/.claude/settings.json` at this script followed
# by the command it replaces, for example:
#
#   "command": "sh /Users/you/projects/agent-desk/tools/claude-statusline-mirror.sh sh /Users/you/.claude/statusline-command.sh"
#
# With no trailing command it mirrors and prints nothing, which is a statusline of one empty line.
#
# AGENTDESK_CLAUDE_LIMITS_MIRROR overrides where the copy lands; it must match the sidecar's
# AGENT_FEED_CLAUDE_LIMITS_MIRROR when either is set.
set -eu

MIRROR=${AGENTDESK_CLAUDE_LIMITS_MIRROR:-"$HOME/.claude/agentdesk-rate-limits.json"}
: "${MIRROR:?mirror path must not be empty}"

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  # Written whole or not at all: the sidecar polls this file, and a reader that catches a partial
  # write sees a parse error rather than a meter. `mktemp` in the mirror's own directory keeps the
  # rename on one filesystem, which is what makes it atomic.
  dir=$(dirname "$MIRROR")
  mkdir -p "$dir"
  tmp=$(mktemp "$dir/.agentdesk-rate-limits.XXXXXX")
  if printf '%s' "$input" \
    | jq -c '{fetchedAtMs: (now * 1000 | floor), rate_limits: (.rate_limits // {})}' >"$tmp" 2>/dev/null
  then
    mv -f "$tmp" "$MIRROR"
  else
    rm -f "$tmp"
  fi
else
  # Said out loud rather than skipped silently: a mirror that quietly stopped writing is
  # indistinguishable from an account with no limits, and this line is the only place anybody
  # would see the difference.
  printf '[rate-limit mirror: jq missing] '
fi

# The statusline the reader actually configured. Every argument is passed through as its own
# argument, so a path with a space in it stays one path.
if [ "$#" -gt 0 ]; then
  printf '%s' "$input" | "$@"
fi
