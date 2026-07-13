#!/bin/sh

printf 'cwd=<%s>\n' "$PWD"
printf 'env=<%s>|<%s>|<%s>|<%s>\n' "$TERM" "$COLORTERM" "$TERM_PROGRAM" "$PTY_SESSION"

index=0
for argument in "$@"; do
    printf 'arg[%d]=<%s>\n' "$index" "$argument"
    index=$((index + 1))
done

if [ "${1:-}" = "--wait-for-input" ]; then
    read -r _
fi
