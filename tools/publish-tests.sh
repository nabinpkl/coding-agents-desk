#!/usr/bin/env bash
# Tests for tools/publish.sh and tools/git-hooks/pre-push, against throwaway repositories: a bare
# one standing in for the public repository, another for the private one, and a working clone
# holding copies of both scripts beside a stand-in for the history scanner. The stand-in records
# what it was asked to scan and passes or fails on STUB_SCAN_STATUS; the real scanner is tested by
# tools/public-scan/public-scan.test.mjs, and it only ever scans its own repository.
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")" && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

public="$tmpdir/public.git"
private="$tmpdir/private.git"
work="$tmpdir/work"
export STUB_SCAN_LOG="$tmpdir/scan.log"
export STUB_SCAN_STATUS=0
: >"$STUB_SCAN_LOG"

git init -q --bare "$public"
git init -q --bare "$private"
git init -q -b main "$work"
g() { git -C "$work" "$@"; }
g config user.name Test
g config user.email test@example.com
g config commit.gpgsign false
g config tag.gpgsign false
g config core.hooksPath "$work/.hooks"
mkdir -p "$work/tools/git-hooks" "$work/tools/public-scan" "$work/.hooks"
cp "$SOURCE/publish.sh" "$work/tools/publish.sh"
cp "$SOURCE/git-hooks/pre-push" "$work/tools/git-hooks/pre-push"
ln -s "$work/tools/git-hooks/pre-push" "$work/.hooks/pre-push"
cat >"$work/tools/public-scan/public-scan.mjs" <<'JS'
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_SCAN_LOG, `${process.argv.slice(2).join(" ")}\n`);
process.exitCode = Number(process.env.STUB_SCAN_STATUS);
JS
g remote add upstream "$public"
g remote add origin "$private"

fail() {
    echo "publish-tests: FAIL: $*" >&2
    exit 1
}
commit() {
    echo "$1" >"$work/file.txt"
    g add file.txt
    g commit -q -m "$1"
}
public_main() { git -C "$public" rev-parse --verify --quiet refs/heads/main || echo none; }
publish() { bash "$work/tools/publish.sh"; }
last_scan() { tail -n 1 "$STUB_SCAN_LOG"; }
scans() { wc -l <"$STUB_SCAN_LOG" | tr -d ' '; }
refused() {
    if "$@" >"$tmpdir/out" 2>&1; then
        cat "$tmpdir/out" >&2
        fail "expected a refusal: $*"
    fi
}
succeeds() {
    if ! "$@" >"$tmpdir/out" 2>&1; then
        cat "$tmpdir/out" >&2
        fail "expected success: $*"
    fi
}
marked_push() {
    local oid="$1"
    shift
    AGENTDESK_PUBLISH_OID="$oid" git -C "$work" push "$@"
}

commit one

# Without agentdesk.publicRemote there is nothing to publish to.
refused publish
[ "$(public_main)" = none ] || fail "publish pushed without agentdesk.publicRemote"

g config agentdesk.publicRemote upstream

# A plain push to the public repository is refused, by remote name and by URL in other spellings.
refused g push upstream main
refused g push "$public" main
refused g push "file://$public/" main
[ "$(public_main)" = none ] || fail "a plain push reached the public repository"

# Every other remote is left alone.
succeeds g push origin main

# The first publish scans all of main and sends it.
succeeds publish
first="$(g rev-parse main)"
[ "$(public_main)" = "$first" ] || fail "the first publish did not reach the public repository"
[ "$(last_scan)" = "--history $first" ] || fail "the first publish scanned '$(last_scan)'"

# With nothing new, nothing is scanned or sent.
before="$(scans)"
succeeds publish
grep -q 'nothing to publish' "$tmpdir/out" || fail "publish with nothing new did not say so"
[ "$(scans)" = "$before" ] || fail "publish scanned with nothing new"

# A scan that does not come up clean stops the push, and only the new commits are scanned.
commit two
second="$(g rev-parse main)"
STUB_SCAN_STATUS=1
refused publish
STUB_SCAN_STATUS=0
[ "$(public_main)" = "$first" ] || fail "a failed scan still pushed"
[ "$(last_scan)" = "--history $first..$second" ] || fail "the second publish scanned '$(last_scan)'"

succeeds publish
[ "$(public_main)" = "$second" ] || fail "the second publish did not reach the public repository"

# Even with the marker, the hook refuses another branch, a tag, a delete, and a commit other than
# the one publish scanned.
refused marked_push "$second" upstream main:refs/heads/other
g tag v1
refused marked_push "$second" upstream v1
refused marked_push "$second" upstream :refs/heads/main
commit three
refused marked_push "$second" upstream main
[ "$(public_main)" = "$second" ] || fail "a refused push moved the public main"
[ -z "$(git -C "$public" for-each-ref refs/tags 'refs/heads/other')" ] || fail "a tag or another branch reached the public repository"

# A rewritten main is refused by publish and, force-pushed with the marker, by the hook.
g reset -q --hard "$first"
commit diverged
refused publish
refused marked_push "$(g rev-parse main)" --force upstream main
[ "$(public_main)" = "$second" ] || fail "a rewritten main reached the public repository"

echo "publish-tests: ok"
