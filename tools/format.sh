#!/usr/bin/env bash
# Formats the two live TypeScript trees and the wire they share with oxfmt, under `.oxfmtrc.json`.
#
#   tools/format.sh                  rewrite every file that is not formatted
#   tools/format.sh <path>...        rewrite only these files: the ones you changed
#   tools/format.sh --check [path]   change nothing, fail naming each file that is not (check 9 of
#                                    tools/agent-feed-fitness.sh, with no paths)
#
# Pass your own files when other sessions are editing the tree: with no paths this rewrites every
# file, a peer's half-finished edit included.
#
# The trees are the ones the lint gate reads, and only their TypeScript: oxfmt also formats
# Markdown, CSS and JSON, and the wire's JSON fixtures are data other code reads. oxfmt is the panel's
# dev dependency, so the panel's dependencies are brought up to date first, as check 8 does.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Options go to oxfmt as they are; anything else is a file, made absolute before the `cd` below so
# a path is read from where the caller stood.
options=()
paths=()
for arg in "$@"; do
    case "$arg" in
        -*) options+=("$arg") ;;
        /*) paths+=("$arg") ;;
        *) paths+=("$PWD/$arg") ;;
    esac
done

cd "$ROOT"
node tools/build-system/ensure-js-dependencies.mjs agent-panel packages/AgentPanel/Web .build/js-dependencies >/dev/null
if [ "${#paths[@]}" -gt 0 ]; then
    exec packages/AgentPanel/Web/node_modules/.bin/oxfmt -c .oxfmtrc.json ${options[@]+"${options[@]}"} "${paths[@]}"
fi
exec packages/AgentPanel/Web/node_modules/.bin/oxfmt -c .oxfmtrc.json ${options[@]+"${options[@]}"} \
    'packages/AgentPanel/Web/src/**/*.ts' 'packages/AgentPanel/Web/src/**/*.tsx' \
    'agent-feed/sidecar/src/**/*.ts' 'agent-feed/wire/**/*.ts' '!**/node_modules/**'
