#!/bin/sh
set -eu

: "${AGENTDESK_AGENT_TERMINAL_FIXTURE_OUTPUT_DIR:?}"
: "${PTY_SESSION:?}"

output="${AGENTDESK_AGENT_TERMINAL_FIXTURE_OUTPUT_DIR}/${PTY_SESSION}.invocation"
temporary="${output}.$$.tmp"

{
    printf '%s\0' "$0" "$PWD" "$$" "$#"
    for argument in "$@"; do
        printf '%s\0' "$argument"
    done
} > "$temporary"
mv "$temporary" "$output"

trap 'exit 0' HUP INT TERM
while IFS= read -r _; do
    :
done
