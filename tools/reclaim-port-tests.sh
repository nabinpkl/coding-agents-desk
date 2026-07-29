#!/usr/bin/env sh
set -eu
# The listener is killed on purpose; job-control notices about it are not failures.
set +m 2>/dev/null || true

# Exercises the real behavior against a real listener, because the failure this
# script exists to prevent is a launch that cannot bind, not a string in a recipe.

port_is_free() {
    [ -z "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)" ]
}

# A listener that is deliberately NOT an AgentDesk process: the earlier version
# refused to kill this and failed the launch. It is started from a subshell that
# exits immediately, so this shell never adopts it as a job and never narrates
# the kill under test into the output.
pid_file="$(mktemp -t reclaim-port-tests)"
trap 'rm -f "$pid_file"' EXIT
(
    /usr/bin/python3 -c '
import socket, time
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(1)
time.sleep(120)
' >/dev/null 2>&1 &
    echo $! > "$pid_file"
)
stranger_pid="$(cat "$pid_file")"
stranger_port="$(
    attempt=0
    while [ "$attempt" -lt 100 ]; do
        found="$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$stranger_pid" -t 2>/dev/null || true)"
        if [ -n "$found" ]; then
            lsof -nP -iTCP -sTCP:LISTEN -a -p "$stranger_pid" -F n 2>/dev/null |
                sed -n 's/^n127\.0\.0\.1:\([0-9]*\)$/\1/p' | head -1
            exit 0
        fi
        attempt=$((attempt + 1))
        sleep 0.05
    done
)"

if [ -z "$stranger_port" ]; then
    kill -9 "$stranger_pid" 2>/dev/null || true
    echo "reclaim port tests could not start a listener" >&2
    exit 1
fi

reclaimed=0
sh tools/reclaim-port.sh "test stranger" "$stranger_port" 2>/dev/null || reclaimed=$?
kill -9 "$stranger_pid" 2>/dev/null || true

if [ "$reclaimed" -ne 0 ]; then
    echo "reclaim-port.sh refused to free a port held by a stranger" >&2
    exit 1
fi

if ! port_is_free "$stranger_port"; then
    echo "reclaim-port.sh returned success while the port was still held" >&2
    exit 1
fi

# A free port is a no-op, not an error: launches call this unconditionally.
if ! sh tools/reclaim-port.sh "test unheld" "$stranger_port"; then
    echo "reclaim-port.sh failed on a port nobody holds" >&2
    exit 1
fi

if sh tools/reclaim-port.sh "test invalid" not-a-port >/dev/null 2>&1; then
    echo "reclaim-port.sh accepted a non-numeric port" >&2
    exit 1
fi

if sh tools/reclaim-port.sh "test missing arg" >/dev/null 2>&1; then
    echo "reclaim-port.sh accepted a missing port" >&2
    exit 1
fi

printf 'reclaim port tests passed\n'
