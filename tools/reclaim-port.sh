#!/usr/bin/env sh
set -eu

# Free a host-owned loopback port before launch, whoever is holding it.
#
# A host that dies without running its teardown leaves its children running, and a sidecar
# still holding its port makes every later one fail to bind. This is one script rather than a
# block copied into each launch recipe, because the copy is the step that gets forgotten. It
# was forgotten for the voice server, and an orphan of it survived a host crash and spun the
# next host's supervisor into 1404 restarts.
#
# These ports are ours by configuration, so a holder we do not recognize is still in our way.
# An earlier version refused to kill a stranger and reported it instead, which turned every
# unrecognized holder into a failed launch that the human had to clear by hand. It also read
# a listener that had already exited as a stranger, because `ps` gives an empty command for a
# dead pid, so a plain race became a hard stop. The holder is reported either way, so the kill
# is never silent.

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
    echo "usage: reclaim-port.sh <label> <tcp-port>" >&2
    exit 2
fi

label="$1"
port="$2"

case "$port" in
    ''|*[!0-9]*)
        echo "port must be numeric" >&2
        exit 2
        ;;
esac

listeners() {
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
}

wait_for_close() {
    attempt=0
    while [ "$attempt" -lt 40 ]; do
        [ -z "$(listeners)" ] && return 0
        attempt=$((attempt + 1))
        sleep 0.05
    done
    return 1
}

pids="$(listeners)"
[ -z "$pids" ] && exit 0

for pid in $pids; do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    printf 'reclaiming %s port %s from pid=%s cmd=%s\n' \
        "$label" "$port" "$pid" "${cmd:-<already exited>}" >&2
done

# shellcheck disable=SC2086
kill $pids 2>/dev/null || true
wait_for_close && exit 0

# shellcheck disable=SC2086
kill -9 $(listeners) 2>/dev/null || true
wait_for_close && exit 0

echo "ERROR: $label port $port did not close" >&2
exit 1
