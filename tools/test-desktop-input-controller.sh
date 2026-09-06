#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
src="$root/tools/grid-encoder"
. "$root/tools/swiftc-cached.sh"
# A stable path rather than a fresh mktemp dir, so the compile can be skipped when
# nothing moved. The test binary still runs every time; only building it is cached.
out="$root/.build/desktop-input-controller-tests"
fixtures="$root/agent-feed/wire/contract-fixture.json"

swiftc_cached "$out" \
  "$src/CursorMirror.swift" \
  "$src/DesktopInputController.swift" \
  "$src/CaptureControlCommand.swift" \
  "$src/DesktopInputControllerTests.swift"

AGENTDESK_CONTROL_FIXTURES="$fixtures" "$out"
