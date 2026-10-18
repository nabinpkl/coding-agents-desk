#!/usr/bin/env bash
# Formats the two live TypeScript trees and the wire they share with oxfmt, under `.oxfmtrc.json`.
#
#   tools/format.sh           rewrite every file that is not formatted
#   tools/format.sh --check   change nothing, fail naming each file that is not (check 9 of
#                             tools/agent-feed-fitness.sh)
#
# The trees are the ones the lint gate reads, and only their TypeScript: oxfmt also formats
# Markdown, CSS and JSON, and the wire's JSON fixtures are data other code reads. oxfmt is the panel's
# dev dependency, so the panel's dependencies are brought up to date first, as check 8 does.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node tools/build-system/ensure-js-dependencies.mjs agent-panel packages/AgentPanel/Web .build/js-dependencies >/dev/null
exec packages/AgentPanel/Web/node_modules/.bin/oxfmt "$@" \
    'packages/AgentPanel/Web/src/**/*.ts' 'packages/AgentPanel/Web/src/**/*.tsx' \
    'agent-feed/sidecar/src/**/*.ts' 'agent-feed/wire/**/*.ts' '!**/node_modules/**'
