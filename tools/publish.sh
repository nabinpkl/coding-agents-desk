#!/usr/bin/env bash
# Publishes `main` to the public repository: the remote that `git config agentdesk.publicRemote`
# names. Run it as `just publish`.
#
# It sends only commits the public repository does not have yet, and only after the history scan
# (`tools/public-scan`, with this machine's personal denylist) finds nothing in them: every blob,
# path, commit message and author identity, plus gitleaks over the same commits. It refuses
# anything that is not a fast-forward of the public `main`.
#
# The push carries the commit it checked in AGENTDESK_PUBLISH_OID, and the pre-push hook
# (`tools/git-hooks/pre-push`) refuses a push to the public repository without it, or with any
# other commit. A peer committing to `main` during the scan therefore changes nothing: the commit
# that was scanned is the one sent.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"

die() {
    echo "publish: $*" >&2
    exit 1
}

remote="$(git -C "$ROOT" config --get agentdesk.publicRemote || true)"
[ -n "$remote" ] || die "no public remote is configured; name it with: git config agentdesk.publicRemote <remote>"
git -C "$ROOT" remote get-url --push "$remote" >/dev/null 2>&1 ||
    die "agentdesk.publicRemote names '$remote', and this repository has no remote by that name"

main="$(git -C "$ROOT" rev-parse --verify --quiet 'refs/heads/main^{commit}')" || die "this repository has no main branch"

# The public repository's main as it is now, asked of the remote itself rather than read from a
# remote-tracking ref that may be stale. Empty on the first publish.
listing="$(git -C "$ROOT" ls-remote "$remote" refs/heads/main)" || die "could not read main from '$remote'"
published="${listing%%$'\t'*}"
if [ -n "$published" ]; then
    if ! git -C "$ROOT" cat-file -e "$published^{commit}" 2>/dev/null; then
        git -C "$ROOT" fetch --quiet --no-tags "$remote" refs/heads/main
    fi
    git -C "$ROOT" merge-base --is-ancestor "$published" "$main" ||
        die "$remote's main (${published:0:8}) is not in this main's history; refusing what would not be a fast-forward"
    if [ "$published" = "$main" ]; then
        echo "publish: $remote already has main at ${main:0:8}; nothing to publish"
        exit 0
    fi
    range="$published..$main"
    count="$(git -C "$ROOT" rev-list --count "$range")"
else
    range="$main"
    count="$(git -C "$ROOT" rev-list --count "$main")"
fi

echo "publish: scanning $count commit(s) for $remote, up to main at ${main:0:8}"
node "$HERE/public-scan/public-scan.mjs" --history "$range" || die "the history scan did not come up clean; nothing was pushed"

AGENTDESK_PUBLISH_OID="$main" git -C "$ROOT" push "$remote" "$main:refs/heads/main"
echo "publish: $remote's main is now ${main:0:8}"
