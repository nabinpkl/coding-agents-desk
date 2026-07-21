#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    echo "usage: exact-executable-pids.sh /absolute/path/to/executable" >&2
    exit 2
fi

executable="$1"
case "$executable" in
    /*) ;;
    *)
        echo "executable path must be absolute" >&2
        exit 2
        ;;
esac

ps -axww -o pid=,command= | awk -v executable="$executable" '
    {
        pid = $1
        sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
        if ($0 == executable || index($0, executable " ") == 1) {
            print pid
        }
    }
'
