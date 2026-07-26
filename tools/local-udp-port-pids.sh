#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    echo "usage: local-udp-port-pids.sh PORT" >&2
    exit 2
fi

port="$1"
case "$port" in
    *[!0-9]*)
        echo "port must be an integer from 1 through 65535" >&2
        exit 2
        ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "port must be an integer from 1 through 65535" >&2
    exit 2
fi

# Parse `lsof -F pn` records. `lsof -iUDP:PORT` matches PORT on either side
# of a connected UDP socket, so inspect only the local endpoint before `->`.
awk -v port="$port" '
    /^p[0-9]+$/ {
        pid = substr($0, 2)
        next
    }
    /^n/ && pid != "" {
        endpoint = substr($0, 2)
        split(endpoint, pair, "->")
        suffix = ":" port
        local_endpoint = pair[1]
        suffix_start = length(local_endpoint) - length(suffix) + 1
        owns_port = suffix_start > 0 \
            && substr(local_endpoint, suffix_start) == suffix
        if (owns_port && !seen[pid]) {
            print pid
            seen[pid] = 1
        }
    }
'
