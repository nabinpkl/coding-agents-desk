#!/usr/bin/env sh
set -eu

usage() {
    cat >&2 <<'EOF'
usage:
  tools/testflight-upload.sh build-number
  tools/testflight-upload.sh require-upload-env
  tools/testflight-upload.sh upload <ipa-path>
EOF
}

build_number() {
    if [ -n "${AGENTDESK_CLIENT_BUILD:-}" ]; then
        printf '%s\n' "$AGENTDESK_CLIENT_BUILD"
        return
    fi
    if [ -n "${AGENTDESK_TESTFLIGHT_NOW_UTC:-}" ]; then
        printf '%s\n' "$AGENTDESK_TESTFLIGHT_NOW_UTC"
        return
    fi
    date -u +%Y%m%d%H%M%S
}

require_var() {
    name="$1"
    case "$name" in
        AGENTDESK_ASC_KEY_ID)
            value="${AGENTDESK_ASC_KEY_ID:-}"
            ;;
        AGENTDESK_ASC_ISSUER_ID)
            value="${AGENTDESK_ASC_ISSUER_ID:-}"
            ;;
        AGENTDESK_ASC_API_KEY_PATH)
            value="${AGENTDESK_ASC_API_KEY_PATH:-}"
            ;;
        *)
            printf 'unknown required variable: %s\n' "$name" >&2
            exit 2
            ;;
    esac
    if [ -z "$value" ]; then
        printf '%s is required\n' "$name" >&2
        exit 1
    fi
}

require_upload_env() {
    require_var AGENTDESK_ASC_KEY_ID
    require_var AGENTDESK_ASC_ISSUER_ID
    require_var AGENTDESK_ASC_API_KEY_PATH
    if [ ! -r "$AGENTDESK_ASC_API_KEY_PATH" ]; then
        printf 'AGENTDESK_ASC_API_KEY_PATH is not readable: %s\n' "$AGENTDESK_ASC_API_KEY_PATH" >&2
        exit 1
    fi
}

upload_ipa() {
    ipa_path="$1"
    require_upload_env
    if [ ! -f "$ipa_path" ]; then
        printf 'IPA does not exist: %s\n' "$ipa_path" >&2
        exit 1
    fi

    if [ "${AGENTDESK_TESTFLIGHT_DRY_RUN:-0}" = "1" ]; then
        printf 'xcrun altool --upload-app -f %s --api-key %s --api-issuer %s --p8-file-path %s --output-format normal\n' \
            "$ipa_path" "$AGENTDESK_ASC_KEY_ID" "$AGENTDESK_ASC_ISSUER_ID" "$AGENTDESK_ASC_API_KEY_PATH"
        return
    fi

    xcrun altool --upload-app \
        -f "$ipa_path" \
        --api-key "$AGENTDESK_ASC_KEY_ID" \
        --api-issuer "$AGENTDESK_ASC_ISSUER_ID" \
        --p8-file-path "$AGENTDESK_ASC_API_KEY_PATH" \
        --output-format normal
}

command="${1:-}"
case "$command" in
    build-number)
        build_number
        ;;
    require-upload-env)
        require_upload_env
        ;;
    upload)
        if [ $# -ne 2 ]; then
            usage
            exit 2
        fi
        upload_ipa "$2"
        ;;
    *)
        usage
        exit 2
        ;;
esac
