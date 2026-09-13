#!/usr/bin/env bash
# Run an agent-feed sidecar on another machine, so the panel's Feed can read that machine's
# transcripts through the session picker it already has.
#
# Why a sidecar there rather than reading files from here: the sidecar IS the transcript reader --
# the catalog, the bounded reads, the live watchers and the event index all live in it, and every
# root it reads is already `$HOME`-relative and env-overridable. Pointing it at another machine's
# home means running it there; reading that home from here would mean a second implementation of
# all of it over ssh, with no file watching to drive the live tail.
#
# The peer is addressed by its ssh host alias, and its sidecar binds the peer's TAILNET address.
# That address is not written down anywhere: it is asked for on the peer, the way
# `tools/tailnet-dns-name.sh` derives this Mac's own name. The tailnet is the auth boundary -- the
# sidecar has no auth of its own, and WireGuard's device authentication is what loopback used to
# stand in for.
#
# Verbs: setup (once per peer), ship, watch, run, stop, status. `run` implies `ship`, so an edit
# reaches the peer with one command.
#
# `watch` is the half that was missing. The peer's sidecar already runs under `bun --watch`, so it
# re-reads its own sources about four seconds after they change -- but they only change when
# somebody runs `ship`, and nobody remembers to. Measured 2026-09-13 on the oracle peer: the
# process had been up two days and four hours, and the newest file in its shipped tree was two days
# old, so every sidecar change made in between was invisible there while the panel showed a healthy
# peer answering `/api/config`. That is the same failure this repo already paid for on the Mac,
# where a host started by launchd ran the frozen bundled sidecar and reported 404s from a build
# that predated the routes: a stale runtime is indistinguishable from a working one until a feature
# is missing.
#
# So `watch` closes the loop: it polls the shipped closure HERE with `find`, which costs nothing
# and touches no network while nothing is changing, and ships only when a file actually moved.
# `bun --watch` on the peer does the rest. An edit reaches the peer the way an edit reaches the
# Mac's own sidecar -- by saving it.

set -euo pipefail

usage="usage: remote-sidecar.sh <setup|ship|watch|run|stop|status> <ssh-host> [port]"
verb="${1:?${usage}}"
peer="${2:?${usage}}"
port="${3:-7682}"

repo="$(cd "$(dirname "$0")/.." && pwd)"

# How often `watch` asks whether the peer is still serving, in seconds.
#
# Slow because it is the recovery path and not the delivery one: an edit is health-checked the
# moment it ships, so this only has to catch a peer that broke while nobody was editing -- a reboot,
# an OOM kill, a tailnet drop. One request a minute is invisible next to what the panel's own
# streams already hold open.
HEALTH_INTERVAL="${AGENTDESK_REMOTE_SIDECAR_HEALTH_SECONDS:-60}"

on_peer() {
    # BatchMode so a missing key fails loudly instead of hanging on a password prompt.
    ssh -o BatchMode=yes "${peer}" "$@"
}

# Resolved once, on the peer, rather than written as `$HOME` into paths. A literal `$HOME` inside
# the quoting survives to the remote shell unexpanded and rsync then creates a directory actually
# called `$HOME` -- and the sidecar's own overrides have to be ABSOLUTE, so there is nothing to be
# gained by leaving them relative either.
remote_home="$(on_peer 'printf %s "$HOME"')"
[ -n "${remote_home}" ] || { echo "could not resolve ${peer}'s home directory" >&2; exit 1; }
# Not /Users/... : that path is a macOS assumption, and it is the reason the sidecar needs
# overrides at all on a Linux peer.
remote_root="${remote_home}/.local/share/agentdesk"
remote_repo="${remote_root}/repo"
bun="${remote_home}/.bun/bin/bun"
log="${remote_root}/sidecar.log"
pidfile="${remote_root}/sidecar.pid"

peer_tailnet_address() {
    on_peer 'tailscale ip -4 2>/dev/null | head -1'
}

# Only the closure the sidecar imports: its own sources, the wire package its tsconfig path points
# at, the runtime-paths helper, and the pty proto the terminal client parses.
#
# An ALLOW-list, not a deny-list, and that is the whole lesson: a deny-list of `node_modules`/`dist`
# shipped 422M of stale `.*.bun-build` compile artifacts sitting in the source directory, over a
# relayed link, because nothing had thought to name them. A deny-list loses to every new kind of
# junk that appears; an allow-list ships 1.8M and cannot.
sidecar_sources=(
    "${repo}/agent-feed/sidecar/src"
    "${repo}/agent-feed/sidecar/patches"
    "${repo}/agent-feed/sidecar/package.json"
    "${repo}/agent-feed/sidecar/bun.lock"
    "${repo}/agent-feed/sidecar/tsconfig.json"
)
wire_source="${repo}/agent-feed/wire"
runtime_paths_source="${repo}/tools/runtime-paths.mjs"
pty_proto_source="${repo}/terminal/pty-manager/proto/pty.proto"

# What `watch` polls, built from the same variables the rsyncs below use rather than written out a
# second time. A path added to the closure and forgotten here would be a file that reaches the peer
# only when somebody ships by hand, which is the exact failure `watch` exists to end.
closure=("${sidecar_sources[@]}" "${wire_source}" "${runtime_paths_source}" "${pty_proto_source}")
# The two files whose change means the peer has to resolve dependencies again. Everything else in
# the closure is source the peer's `bun --watch` re-reads by itself.
manifest=("${repo}/agent-feed/sidecar/package.json" "${repo}/agent-feed/sidecar/bun.lock")

ship_sources() {
    on_peer "mkdir -p '${remote_repo}/agent-feed/sidecar' '${remote_repo}/tools' '${remote_repo}/terminal/pty-manager/proto'"
    rsync -a --delete "${sidecar_sources[@]}" "${peer}:${remote_repo}/agent-feed/sidecar/"
    rsync -a --delete "${wire_source}" "${peer}:${remote_repo}/agent-feed/"
    rsync -a "${runtime_paths_source}" "${peer}:${remote_repo}/tools/"
    rsync -a "${pty_proto_source}" "${peer}:${remote_repo}/terminal/pty-manager/proto/"
}

ship_dependencies() {
    on_peer "cd '${remote_repo}/agent-feed/sidecar' && '${bun}' install --frozen-lockfile"
}

# Anything under the watched closure saved since `${1}` was stamped. Stops at the first hit, so the
# common answer -- nothing -- costs one local directory walk and no network.
changed_since() {
    find "${@:2}" -newer "${1}" -type f -print -quit 2>/dev/null
}

stop_sidecar() {
    on_peer "if [ -f '${pidfile}' ]; then kill \$(cat '${pidfile}') 2>/dev/null || true; rm -f '${pidfile}'; fi"
}

# Starts the peer's sidecar under `bun --watch`, bound to the address it is reachable at.
#
# The overrides are not cosmetic. `runtimePaths()` has no platform branch: its runtime root is
# ~/Library/Application Support and its rendezvous board is /Users/Shared, and `announceSidecar`
# runs at module scope, so on Linux the board mkdir throws EACCES and the sidecar dies at boot. The
# board is unread on the peer -- this panel declares the peer rather than discovering it -- so it
# only has to be somewhere writable.
#
# The transcript roots are deliberately absent: they already default to $HOME/.claude/... , so the
# peer's own home is picked up with nothing said about it.
launch_sidecar() {
    on_peer "cd '${remote_repo}/agent-feed/sidecar' && \
        AGENTDESK_RUNTIME_ROOT='${remote_root}/runtime' \
        AGENTDESK_SIDECAR_REGISTRY='${remote_root}/sidecars' \
        AGENT_FEED_HOST='${1}' \
        AGENT_FEED_PORT='${port}' \
        nohup '${bun}' --watch src/server.ts > '${log}' 2>&1 & echo \$! > '${pidfile}'"
}

# Reachable FROM THIS MAC, which is the property that matters. A sidecar bound to loopback on the
# peer is running and fails this.
sidecar_answers() {
    [ -n "${1}" ] && curl -sf --max-time 5 "http://${1}:${port}/api/config" >/dev/null 2>&1
}

# The peer is serving, whatever it takes.
#
# Re-resolves the address first, because the reason it stopped answering may be that the peer
# rebooted, and a rebooted peer is exactly the case where an address captured earlier is the thing
# that is wrong. Prints when it acts; a supervisor that heals silently is one you cannot tell from
# a peer that never broke.
ensure_running() {
    if sidecar_answers "${address}"; then return 0; fi
    resolved="$(peer_tailnet_address || true)"
    if [ -z "${resolved}" ]; then
        echo "  ${peer} has no tailnet address -- not relaunching"
        return 1
    fi
    if [ "${resolved}" != "${address}" ]; then
        echo "  ${peer} moved to ${resolved}; the panel still declares ${address}"
        address="${resolved}"
    fi
    if sidecar_answers "${address}"; then return 0; fi
    echo "  ${peer} is not serving -- relaunching its sidecar"
    stop_sidecar || true
    launch_sidecar "${address}"
    sleep 3
    if sidecar_answers "${address}"; then
        echo "  ${peer} is back on http://${address}:${port}"
        return 0
    fi
    echo "  ${peer} still not answering -- ssh ${peer} tail ${log}"
    return 1
}

case "${verb}" in
setup)
    # tmux is what the Terminals tab attaches to; bun is what runs the sidecar. Neither is assumed
    # present, and both are idempotent to ask for again.
    on_peer 'set -e
        if ! command -v tmux >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq tmux; fi
        if [ ! -x "$HOME/.bun/bin/bun" ]; then curl -fsSL https://bun.sh/install | bash >/dev/null; fi
        mkdir -p "$HOME/.local/share/agentdesk"
        printf "tmux %s\nbun  %s\n" "$(tmux -V)" "$("$HOME/.bun/bin/bun" --version)"'
    ;;
ship)
    ship_sources
    ship_dependencies
    ;;
watch)
    # The peer's half of the no-rebuild loop, and the thing that is supposed to be running whenever
    # this Mac is. It does two jobs, and they are one job: keep the peer's files current, and keep
    # the peer serving. Neither is worth anything alone -- shipping into a dead sidecar and
    # supervising a two-day-old tree are the same failure wearing different clothes.
    address="$(peer_tailnet_address || true)"
    stamp="$(mktemp)"
    trap 'rm -f "${stamp}"' EXIT
    ensure_running || true
    ship_sources
    ship_dependencies
    echo "watching ${#closure[@]} paths for ${peer} at ${address:-<unreachable>}:${port}. ctrl-c to stop."
    # When the peer was last asked whether it is serving. Seconds, from the same clock as `date`,
    # so a machine that sleeps and wakes asks again immediately rather than on a counter that
    # stopped with it.
    checked=0
    while :; do
        sleep 1
        now="$(date +%s)"
        if [ "$((now - checked))" -ge "${HEALTH_INTERVAL}" ]; then
            checked="${now}"
            ensure_running || true
        fi
        [ -n "$(changed_since "${stamp}" "${closure[@]}")" ] || continue
        # Asked before the stamp moves, because the stamp is what it is measured against.
        install_needed="$(changed_since "${stamp}" "${manifest[@]}")"
        # Stamped BEFORE the ship, so an edit saved DURING one is newer than the stamp and lands on
        # the next pass instead of being swallowed by this one.
        touch "${stamp}"
        ship_sources
        [ -z "${install_needed}" ] || ship_dependencies
        printf '%s  shipped to %s\n' "$(date +%H:%M:%S)" "${peer}"
        # Checked after every edit rather than only on the interval, because an edit is the most
        # likely thing to have broken it. `bun --watch` reloads in process and rebinds the port, so
        # a reload that THREW leaves a live process with nothing listening -- indistinguishable
        # from a healthy peer until something asks it for data. Same trap as on the Mac, where the
        # host now probes the port rather than the process.
        sleep 5
        checked="$(date +%s)"
        ensure_running || true
    done
    ;;
run)
    ship_sources
    ship_dependencies
    address="$(peer_tailnet_address)"
    [ -n "${address}" ] || { echo "peer ${peer} has no tailnet address" >&2; exit 1; }
    stop_sidecar >/dev/null 2>&1 || true
    launch_sidecar "${address}"
    echo "sidecar starting on ${peer} at http://${address}:${port} (log: ${log})"
    echo "declare it for the panel with:"
    echo "  AGENTDESK_PANEL_REMOTE_SIDECARS=${peer}=${address}:${port}"
    echo "keep it current, and running, with:"
    echo "  just dev-login-install     (every login, every peer in .env)"
    echo "  just remote-sidecar-watch ${peer}   (this one, in the foreground)"
    ;;
stop)
    stop_sidecar
    ;;
status)
    address="$(peer_tailnet_address)"
    echo "peer          ${peer}"
    echo "tailnet       ${address:-<none>}"
    on_peer "if [ -f '${pidfile}' ] && kill -0 \$(cat '${pidfile}') 2>/dev/null; then echo 'process       running (pid '\$(cat '${pidfile}')')'; else echo 'process       not running'; fi"
    # WHICH code it is serving, which is the question every other line here fails to answer. A
    # sidecar under `bun --watch` keeps its port across a reload, so a tree two days stale answers
    # /api/config exactly as a current one does -- and that is how the oracle peer spent two days
    # serving code nobody had shipped. Compared against this repo, not against the clock, because
    # "up to date" means "the same as here".
    newest_here="$(find "${closure[@]}" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)"
    newest_there="$(on_peer "find '${remote_repo}/agent-feed/sidecar/src' '${remote_repo}/agent-feed/wire' -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1" || true)"
    if [ -z "${newest_there}" ]; then
        echo "shipped       nothing shipped yet"
    elif [ -z "${newest_here}" ]; then
        echo "shipped       $(date -r "${newest_there}" '+%Y-%m-%d %H:%M')"
    else
        behind="$(( newest_here - newest_there ))"
        if [ "${behind}" -le 2 ]; then
            echo "shipped       current with this repo"
        else
            echo "shipped       $(date -r "${newest_there}" '+%Y-%m-%d %H:%M'), $(( behind / 3600 ))h behind this repo"
            echo "              start the watcher: just remote-sidecar-watch ${peer}"
        fi
    fi
    # Asked from HERE, because reachable-from-the-Mac is the property that matters, not
    # listening-on-the-peer. A sidecar bound to loopback on the peer passes the second and fails this.
    if sidecar_answers "${address}"; then
        echo "from this Mac  answering on http://${address}:${port}/api/config"
    else
        echo "from this Mac  NOT answering on http://${address:-?}:${port}/api/config"
        on_peer "tail -5 '${log}' 2>/dev/null" || true
    fi
    ;;
*)
    echo "${usage}" >&2
    exit 2
    ;;
esac
