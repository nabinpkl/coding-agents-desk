#!/usr/bin/env sh
set -eu

fixture='p100
n*:41888
p100
n127.0.0.1:41888
p200
n[::1]:63738->[::1]:41888
p300
n127.0.0.1:41888->127.0.0.1:50000
p400
n[::]:41889'

actual="$(
    printf '%s\n' "$fixture" |
        sh tools/local-udp-port-pids.sh 41888
)"
expected='100
300'
if [ "$actual" != "$expected" ]; then
    printf 'local UDP port PID parser mismatch\nexpected:\n%s\nactual:\n%s\n' \
        "$expected" "$actual" >&2
    exit 1
fi

if printf 'p1\nn*:41888\n' |
    sh tools/local-udp-port-pids.sh invalid >/dev/null 2>&1
then
    echo "local UDP port PID parser accepted an invalid port" >&2
    exit 1
fi

printf 'local UDP port PID tests passed\n'
