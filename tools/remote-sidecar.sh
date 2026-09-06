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
# Verbs: setup (once per peer), ship, run, stop, status. `run` implies `ship`, so an edit reaches
# the peer with one command.

set -euo pipefail

usage="usage: remote-sidecar.sh <setup|ship|run|stop|status> <ssh-host> [port]"
verb="${1:?${usage}}"
peer="${2:?${usage}}"
port="${3:-7682}"

repo="$(cd "$(dirname "$0")/.." && pwd)"

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
    # Only the closure the sidecar imports: its own sources, the wire package its tsconfig path
    # points at, the runtime-paths helper, and the pty proto the terminal client parses.
    #
    # An ALLOW-list, not a deny-list, and that is the whole lesson: a deny-list of
    # `node_modules`/`dist` shipped 422M of stale `.*.bun-build` compile artifacts sitting in the
    # source directory, over a relayed link, because nothing had thought to name them. A deny-list
    # loses to every new kind of junk that appears; an allow-list ships 1.8M and cannot.
    on_peer "mkdir -p '${remote_repo}/agent-feed/sidecar' '${remote_repo}/tools' '${remote_repo}/terminal/pty-manager/proto'"
    rsync -a --delete \
        "${repo}/agent-feed/sidecar/src" "${repo}/agent-feed/sidecar/patches" \
        "${repo}/agent-feed/sidecar/package.json" "${repo}/agent-feed/sidecar/bun.lock" \
        "${repo}/agent-feed/sidecar/tsconfig.json" \
        "${peer}:${remote_repo}/agent-feed/sidecar/"
    rsync -a --delete "${repo}/agent-feed/wire" "${peer}:${remote_repo}/agent-feed/"
    rsync -a "${repo}/tools/runtime-paths.mjs" "${peer}:${remote_repo}/tools/"
    rsync -a "${repo}/terminal/pty-manager/proto/pty.proto" \
        "${peer}:${remote_repo}/terminal/pty-manager/proto/"
    on_peer "cd '${remote_repo}/agent-feed/sidecar' && '${bun}' install --frozen-lockfile"
    ;;
run)
    "$0" ship "${peer}" "${port}"
    address="$(peer_tailnet_address)"
    [ -n "${address}" ] || { echo "peer ${peer} has no tailnet address" >&2; exit 1; }
    "$0" stop "${peer}" "${port}" >/dev/null 2>&1 || true
    # The overrides are not cosmetic. `runtimePaths()` has no platform branch: its runtime root is
    # ~/Library/Application Support and its rendezvous board is /Users/Shared, and `announceSidecar`
    # runs at module scope, so on Linux the board mkdir throws EACCES and the sidecar dies at boot.
    # The board is unread on the peer -- this panel declares the peer rather than discovering it --
    # so it only has to be somewhere writable.
    #
    # The transcript roots are deliberately absent: they already default to $HOME/.claude/... , so
    # the peer's own home is picked up with nothing said about it.
    on_peer "cd '${remote_repo}/agent-feed/sidecar' && \
        AGENTDESK_RUNTIME_ROOT='${remote_root}/runtime' \
        AGENTDESK_SIDECAR_REGISTRY='${remote_root}/sidecars' \
        AGENT_FEED_HOST='${address}' \
        AGENT_FEED_PORT='${port}' \
        nohup '${bun}' --watch src/server.ts > '${log}' 2>&1 & echo \$! > '${pidfile}'"
    echo "sidecar starting on ${peer} at http://${address}:${port} (log: ${log})"
    echo "declare it for the panel with:"
    echo "  AGENTDESK_PANEL_REMOTE_SIDECARS=${peer}=${address}:${port}"
    ;;
stop)
    on_peer "if [ -f '${pidfile}' ]; then kill \$(cat '${pidfile}') 2>/dev/null || true; rm -f '${pidfile}'; fi"
    ;;
status)
    address="$(peer_tailnet_address)"
    echo "peer          ${peer}"
    echo "tailnet       ${address:-<none>}"
    on_peer "if [ -f '${pidfile}' ] && kill -0 \$(cat '${pidfile}') 2>/dev/null; then echo 'process       running (pid '\$(cat '${pidfile}')')'; else echo 'process       not running'; fi"
    # Asked from HERE, because reachable-from-the-Mac is the property that matters, not
    # listening-on-the-peer. A sidecar bound to loopback on the peer passes the second and fails this.
    if [ -n "${address}" ] && curl -sf --max-time 5 "http://${address}:${port}/api/config" >/dev/null; then
        echo "from this Mac  answering on http://${address}:${port}/api/config"
    else
        echo "from this Mac  NOT answering on http://${address:-?}:${port}/api/config"
        on_peer "tail -5 '${log}' 2>/dev/null" || true
    fi
    ;;
*)
    echo "usage: remote-sidecar.sh <setup|ship|run|stop|status> <ssh-host> [port]" >&2
    exit 2
    ;;
esac
