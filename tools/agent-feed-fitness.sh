#!/usr/bin/env bash
# Keeps the agent feed's model out of Swift.
#
# The feed used to be stated four times: once by the sidecar in TypeScript, once by the host's
# sidecar client in long keys, once again in `AgentDeskWire` in abbreviated keys, and once more by
# a bridge that renamed the second into the third. Every per-side test passed on both sides of
# every drift, which is why this is a build gate and not a test.
#
# The rule the gate enforces is the three-owner split: the sidecar owns the model, the panel owns
# the view, and Swift owns transport and native authority and never names a payload field. Each
# check below is one way that split has already been broken once, so a "just one field" that puts
# a struct back fails here rather than in six months of silent divergence.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
    echo "agent-feed-fitness: $1" >&2
    exit 1
}

# 1. The renaming layer stays deleted. It existed only to turn one Swift restatement of the feed
#    into another; nothing can need it back without the restatements coming back first.
if [ -e host/AgentDeskHost/AgentFeedBridge.swift ]; then
    fail "AgentFeedBridge.swift is back: the feed is being renamed in Swift again"
fi

# 2. No feed payload type in Swift. Named individually rather than by pattern because the
#    native-authority types share the same prefix on purpose and must keep compiling: these are
#    exactly the shapes that moved to the sidecar.
banned_types='ActivityBlock ActivityEvent EventCacheHit TokenUsage AgentJSONValue
AgentProjectSummary AgentProjectsWatch AgentProjectsUnwatch AgentProjectsPush AgentProjectsError
AgentProjectSessionsWatch AgentProjectSessionsUnwatch AgentProjectSessionsPush
AgentProjectSessionsError AgentThreadSubscribe AgentThreadLoadOlder AgentThreadUnsubscribe
AgentThreadChunk AgentThreadError AgentLiveTail AgentSessionCreate AgentSessionSend
AgentSessionAbort AgentCommandReceipt AgentCommandError AgentExtensionUIRequest
AgentExtensionUIResponse AgentExtensionUIDismissed AgentRawEventRequest AgentRawEventChunk
AgentRawEventError'
for name in $banned_types; do
    if git grep -qw "$name" -- '*.swift'; then
        echo "agent-feed-fitness: $name is a feed payload type and belongs to the sidecar:" >&2
        git grep -nw "$name" -- '*.swift' >&2
        exit 1
    fi
done

# 3. The host names ONE sidecar path. The relay reaches every route by copying the path the panel
#    asked for, so a second literal means some operation grew a Swift-side endpoint again. The one
#    that survives is native authority: the terminal handoff asks whether a session is live before
#    taking its PTY over, and that is a capability decision, not a view of the feed.
path_hits="$(git grep -c '"/api' -- 'host/AgentDeskHost/*.swift' || true)"
path_total="$(printf '%s\n' "$path_hits" | awk -F: '{ sum += $2 } END { print sum + 0 }')"
if [ "$path_total" -gt 1 ]; then
    echo "agent-feed-fitness: the host names $path_total sidecar paths; the relay needs none:" >&2
    git grep -n '"/api' -- 'host/AgentDeskHost/*.swift' >&2
    exit 1
fi

# 4. Every panel request tag is either the opaque relay or a named native capability. A feed
#    operation reappearing as its own tag is how the typed path grew the first time: one tag per
#    operation, each with its own payload, each needing a struct on both sides.
bad_tags="$(
    grep -o 'case "agent-[a-z-]*"' packages/AgentPanel/Sources/AgentPanel/AgentPanelRequest.swift \
        | sed 's/case "//; s/"//' \
        | grep -Ev '^agent-http-(req|cancel)$|^agent-window-|^agent-terminal-|^agent-say$' || true
)"
if [ -n "$bad_tags" ]; then
    echo "agent-feed-fitness: these request tags are neither the relay nor native authority:" >&2
    printf '  %s\n' $bad_tags >&2
    exit 1
fi

echo "agent-feed-fitness: OK"
