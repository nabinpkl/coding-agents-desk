#!/usr/bin/env sh
set -eu

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

assert_eq() {
    expected="$1"
    actual="$2"
    label="$3"
    if [ "$expected" != "$actual" ]; then
        printf 'unexpected %s\nexpected: %s\nactual:   %s\n' "$label" "$expected" "$actual" >&2
        exit 1
    fi
}

fixed_build="$(AGENTDESK_TESTFLIGHT_NOW_UTC=20260621173045 tools/testflight-upload.sh build-number)"
assert_eq "20260621173045" "$fixed_build" "timestamp build number"

override_build="$(AGENTDESK_CLIENT_BUILD=42 AGENTDESK_TESTFLIGHT_NOW_UTC=20260621173045 tools/testflight-upload.sh build-number)"
assert_eq "42" "$override_build" "overridden build number"

if tools/testflight-upload.sh require-upload-env 2>"$tmpdir/missing-env.err"; then
    echo "require-upload-env succeeded without credentials" >&2
    exit 1
fi
grep -F "AGENTDESK_ASC_KEY_ID is required" "$tmpdir/missing-env.err" >/dev/null

key_path="$tmpdir/AuthKey_TESTKEY123.p8"
ipa_path="$tmpdir/AgentDeskClient.ipa"
printf '%s\n' "PRIVATE KEY" > "$key_path"
printf '%s\n' "ipa" > "$ipa_path"

dry_run="$(
    AGENTDESK_ASC_KEY_ID=TESTKEY123 \
    AGENTDESK_ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000 \
    AGENTDESK_ASC_API_KEY_PATH="$key_path" \
    AGENTDESK_TESTFLIGHT_DRY_RUN=1 \
    tools/testflight-upload.sh upload "$ipa_path"
)"

printf '%s\n' "$dry_run" | grep -F "xcrun altool --upload-app" >/dev/null
printf '%s\n' "$dry_run" | grep -F -- "--api-key TESTKEY123" >/dev/null
printf '%s\n' "$dry_run" | grep -F -- "--api-issuer 00000000-0000-0000-0000-000000000000" >/dev/null
printf '%s\n' "$dry_run" | grep -F -- "--p8-file-path $key_path" >/dev/null
printf '%s\n' "$dry_run" | grep -F -- "-f $ipa_path" >/dev/null

printf 'testflight upload tests passed\n'
