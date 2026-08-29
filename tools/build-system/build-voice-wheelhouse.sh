#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
    echo "usage: $0 <uv-bin> <voice-source> <wheelhouse-output> <stage-hash>" >&2
    exit 2
fi

UV_BIN="$1"
SOURCE="$2"
OUTPUT="$3"
STAGE_HASH="$4"
PIP_VERSION="26.0.1"
BUILD_CONSTRAINTS="$(cd "$(dirname "$0")" && pwd)/voice-build-constraints.txt"

if [ ! -x "$UV_BIN" ]; then
    echo "build-voice-wheelhouse: uv is not executable: $UV_BIN" >&2
    exit 1
fi
if [ ! -f "$SOURCE/pyproject.toml" ] || [ ! -f "$SOURCE/uv.lock" ]; then
    echo "build-voice-wheelhouse: source is missing pyproject.toml or uv.lock: $SOURCE" >&2
    exit 1
fi
case "$OUTPUT" in
    */host/AgentDeskHost/voice-wheelhouse) ;;
    *)
        echo "build-voice-wheelhouse: refusing unexpected output path: $OUTPUT" >&2
        exit 1
        ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentdesk-voice-wheelhouse.XXXXXX")"
cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT

REQUIREMENTS="$WORK/requirements.lock.txt"
PACKAGES="$WORK/voice-wheelhouse"
DOWNLOADER="$WORK/downloader"
mkdir -p "$PACKAGES"

# Export the core dependency closure exactly as locked. The local project is
# installed from the bundled source at first launch, so it is not duplicated as
# a wheel here.
(
    cd "$SOURCE"
    "$UV_BIN" export \
        --locked \
        --no-dev \
        --no-emit-project \
        --format requirements.txt \
        --output-file "$REQUIREMENTS" >/dev/null
)

# pip's download command preserves the distributions uv can consume through a
# flat --find-links directory. Bootstrap a pinned pip into a disposable Python
# 3.13 venv; it never enters the shipped host or runtime venv.
UV_CACHE_DIR="$WORK/bootstrap-uv-cache" \
    "$UV_BIN" venv "$DOWNLOADER" --python 3.13 >/dev/null
UV_CACHE_DIR="$WORK/bootstrap-uv-cache" \
    "$UV_BIN" --system-certs pip install \
        --python "$DOWNLOADER/bin/python" \
        "pip==$PIP_VERSION" >/dev/null

PIP_CACHE_DIR="$WORK/pip-cache" \
    "$DOWNLOADER/bin/pip" download \
        --quiet \
        --build-constraint "$BUILD_CONSTRAINTS" \
        --no-deps \
        --ignore-requires-python \
        --require-hashes \
        --dest "$PACKAGES" \
        --requirement "$REQUIREMENTS"

# A few locked projects publish source distributions only. Build those now so
# first launch requires neither network access nor a compiler/build backend.
while IFS= read -r -d '' archive; do
    PIP_CACHE_DIR="$WORK/pip-cache" \
        "$DOWNLOADER/bin/pip" wheel \
            --quiet \
            --build-constraint "$BUILD_CONSTRAINTS" \
            --no-deps \
            --wheel-dir "$PACKAGES" \
            "$archive"
done < <(find "$PACKAGES" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.zip' \) -print0)
find "$PACKAGES" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.zip' \) -delete

cp "$REQUIREMENTS" "$PACKAGES/requirements.lock.txt"
printf '%s\n' "$STAGE_HASH" > "$PACKAGES/.stage-hash"
: > "$PACKAGES/.gitkeep"
(
    cd "$PACKAGES"
    find . -maxdepth 1 -type f -name '*.whl' -print \
        | LC_ALL=C sort \
        | while IFS= read -r wheel; do shasum -a 256 "$wheel"; done \
        > SHA256SUMS
)

# Prove completeness against an empty cache before publishing. UV_NO_CONFIG is
# the runtime posture too, so a developer's global uv settings cannot make this
# check pass accidentally.
VALIDATION_VENV="$WORK/validation-venv"
UV_CACHE_DIR="$WORK/validation-uv-cache" \
    "$UV_BIN" venv "$VALIDATION_VENV" --python 3.13 >/dev/null
UV_NO_CONFIG=1 UV_CACHE_DIR="$WORK/validation-uv-cache" \
    "$UV_BIN" pip install \
        --python "$VALIDATION_VENV/bin/python" \
        "$SOURCE" \
        --find-links "$PACKAGES" \
        --offline \
        --no-cache >/dev/null
test -x "$VALIDATION_VENV/bin/voice-server"
"$VALIDATION_VENV/bin/python" -c 'import interaction_agent.voice.http_server'

# OUTPUT is generated and guarded above. Publish only after the empty-cache
# validation succeeds. If the final rename fails, restore the prior known-good
# house before returning the failure.
mkdir -p "$(dirname "$OUTPUT")"
PREVIOUS="$WORK/previous-wheelhouse"
if [ -e "$OUTPUT" ]; then
    mv "$OUTPUT" "$PREVIOUS"
fi
if ! mv "$PACKAGES" "$OUTPUT"; then
    if [ -e "$PREVIOUS" ]; then
        mv "$PREVIOUS" "$OUTPUT"
    fi
    exit 1
fi

WHEEL_COUNT="$(find "$OUTPUT" -maxdepth 1 -type f -name '*.whl' | wc -l | tr -d ' ')"
WHEEL_SIZE="$(du -sh "$OUTPUT" | awk '{print $1}')"
echo "build-voice-wheelhouse: published $WHEEL_COUNT wheels ($WHEEL_SIZE)"
