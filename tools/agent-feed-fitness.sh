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

# 5. No file in the two live TypeScript trees runs past 500 lines. Not a style rule: a file that
#    long has stopped being one idea, and the reader who needs one of the ideas in it pays for
#    all of them. The cap is what makes a growing file split at the moment it stops being about
#    one thing, rather than at the moment somebody has an afternoon to spend on it. Both trees
#    were brought under it file by file; this is what keeps them there.
oversize="$(
    find packages/AgentPanel/Web/src agent-feed/sidecar/src \
        \( -name '*.ts' -o -name '*.tsx' \) -print0 \
        | xargs -0 wc -l \
        | awk '$2 != "total" && $1 > 500 { print "  " $1 " " $2 }'
)"
if [ -n "$oversize" ]; then
    echo "agent-feed-fitness: these files are past the 500-line cap:" >&2
    printf '%s\n' "$oversize" >&2
    exit 1
fi

# 6. No relative import inside the two live TypeScript trees. `@/` is the project's own src and
#    `@repo/` is the repository; both say where a module lives, while `../../..` says how far away
#    the reader happens to be sitting. The difference is not style, it is what a file move costs: a
#    relative import breaks when EITHER end moves, so clustering one directory rewrote every file
#    inside it AND every importer of it. An aliased one names only the thing that moved.
#
#    Three patterns, because a specifier is written three ways here: a static import or re-export,
#    a bare side-effect import, and a call form (`import()`, `vi.mock()`, `mock.module()`,
#    `require()`). Anchored or parenthesised so a specifier quoted INSIDE a string stays legal --
#    `config.test.ts` embeds one in a script it hands to `bun -e`, and that one is a real relative
#    import, just not this file's.
#
#    `mock.module` is in the call form because it was missing from it, and the omission cost
#    something: `sessionRoutes.test.ts` mocked a module as `"../input/tmuxComposer.ts"`, which
#    survived the migration unseen, and moving that file into a subdirectory re-pointed the mock at
#    a directory that does not exist. The mock silently stopped applying and two tests failed
#    against the real implementation instead.
relative_imports="$(
    git grep -nE \
        '^[[:space:]]*(import|export)[^"'"'"']*from[[:space:]]*["'"'"']\.|^[[:space:]]*import[[:space:]]*["'"'"']\.|(import|vi\.mock|mock\.module|require)\([[:space:]]*["'"'"']\.' \
        -- 'packages/AgentPanel/Web/src/*.ts' 'packages/AgentPanel/Web/src/*.tsx' \
           'agent-feed/sidecar/src/*.ts' 'agent-feed/sidecar/src/*.tsx' || true
)"
if [ -n "$relative_imports" ]; then
    echo "agent-feed-fitness: these are relative imports; write @/ or @repo/ instead:" >&2
    printf '%s\n' "$relative_imports" >&2
    exit 1
fi

# 7. No directory in the two live TypeScript trees holds more than twelve source files. The other
#    half of check 5, and the failure check 5 produces on its own: bring every file under 500 lines
#    and you get directories of fifty files that are each one idea, where a reader still cannot see
#    where one thing ends and the next begins. A flat list of fifty hides exactly what a
#    two-thousand-line file hid.
#
#    Twelve because this tree's own distribution had a gap there -- 53, 36, 26, 24, 20, 17, 16, 15,
#    13, 13, 12, 12, and then 10 and below -- so twelve is where a place stopped and a pile started
#    here, rather than a number somebody liked.
#
#    A test rides with its source and is not counted: `foo.ts` and `foo.test.ts` are one thing, and
#    counting them separately would push a directory over for writing tests.
#
#    The ceiling is gated and the three-file floor deliberately is NOT. The floor governs the moment
#    you are splitting -- a group of one or two is not a cluster, so those files stay flat -- and
#    says nothing about a directory that is simply small. `features/screen-viewer/` is one file and
#    `src/types/` is one file, and both are a whole thing that happens to be small rather than the
#    residue of a bad split. A check that failed every directory under three would fail five that
#    are correct as they are. See AGENTS.md, "How long a file gets, and how flat a directory gets".
#
#    And the floor is asked of the cluster you are PROMOTING, never of the file that pushed the
#    directory over. A full directory owes a split whatever is arriving: relieve it by moving three
#    or more of the files already in it that belong together, and then the newcomer lands flat.
#    Reading the floor the other way -- "a directory for my new thing would hold two files, so I
#    will append it to an existing file instead" -- keeps both caps green while hiding a new idea
#    inside a file named for a different one, which is the failure they exist to prevent.
oversized_dirs="$(
    find packages/AgentPanel/Web/src agent-feed/sidecar/src -type d -print0 \
        | while IFS= read -r -d '' dir; do
            count="$(
                find "$dir" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' \) \
                    ! -name '*.test.ts' ! -name '*.test.tsx' | wc -l | tr -d ' '
            )"
            # An `if` rather than `&&`, so a final directory that is under the cap does not leave
            # the loop -- and with it the command substitution -- exiting non-zero under `set -e`.
            if [ "$count" -gt 12 ]; then printf '  %s %s\n' "$count" "$dir"; fi
        done
)"
if [ -n "$oversized_dirs" ]; then
    echo "agent-feed-fitness: these directories hold more than twelve source files:" >&2
    printf '%s\n' "$oversized_dirs" >&2
    echo "agent-feed-fitness: cluster the files ALREADY THERE that are about the same thing into" >&2
    echo "agent-feed-fitness: sibling directories, then put the new file flat. Three or more is a" >&2
    echo "agent-feed-fitness: cluster, and that floor is asked of the group you are MOVING, never" >&2
    echo "agent-feed-fitness: of the file that arrived. Do not append it to an existing file to" >&2
    echo "agent-feed-fitness: dodge the count: that keeps both caps green and buries a new idea" >&2
    echo "agent-feed-fitness: inside a file named for a different one." >&2
    exit 1
fi

# 8. The lint rules in `.oxlintrc.json`, over both live trees and the wire they share. Here rather
#    than in a leg of its own because this gate runs on every `just check`, whatever the diff
#    touched, and a lint finding is the same kind of fact about the tree as checks 5 to 7. oxlint is
#    the panel's dev dependency, so the panel's dependencies are brought up to date first.
node tools/build-system/ensure-js-dependencies.mjs agent-panel packages/AgentPanel/Web .build/js-dependencies
# oxlint looks for tsgolint, the type checker behind its type-aware rules, beside the directory it
# runs in, and this runs from the repository root.
#
# A disable comment that silences nothing fails too. Eight once named `react-hooks/exhaustive-deps`,
# a rule this repo never ran, and each still hid the function it sat in from React Compiler and from
# the compiler's own lint rules: five findings went unseen behind them.
if ! OXLINT_TSGOLINT_PATH="$ROOT/packages/AgentPanel/Web/node_modules/.bin/tsgolint" \
    packages/AgentPanel/Web/node_modules/.bin/oxlint -c .oxlintrc.json \
    --report-unused-disable-directives-severity=error \
    packages/AgentPanel/Web/src agent-feed/sidecar/src agent-feed/wire; then
    fail "lint failed (rules and the reason for each are in .oxlintrc.json)"
fi
# The effect ban reads imports, so `React.useEffect` through a namespace import walks past it.
if grep -rnE '\bReact\.use(Layout|Insertion)?Effect\b' packages/AgentPanel/Web/src \
    --include='*.ts' --include='*.tsx' | grep -vE '\.test\.tsx?:|/src/hooks/'; then
    fail "an effect reached through the React namespace; ADR-0146 bans them outside src/hooks"
fi

# 9. Every file in those trees is as oxfmt would write it (`.oxfmtrc.json`). Checked rather than
#    applied on save, because several sessions edit this tree at once: a formatter that ran
#    behind one of them would rewrite a file another is mid-edit in. The pre-commit hook asks the
#    same of each staged file, so a file that fails here is usually one still being written.
if ! tools/format.sh --check >/dev/null; then
    tools/format.sh --list-different >&2 || true
    fail "files not formatted; run tools/format.sh"
fi

# 10. No personal data and no credential shape beyond what was already in the tree when the
#     public-release cleanup began. The whole repository, not just the two live trees, because a
#     name or an account id in a test fixture or an ADR is published as surely as one in source.
#     The personal patterns live outside the checkout, so a machine without them checks the secret
#     shapes only, and says so. `tools/public-scan/README.md` has the rest.
if ! node tools/public-scan/public-scan.mjs; then
    fail "the public scan found something to keep out of the tree (see above)"
fi

echo "agent-feed-fitness: OK"
