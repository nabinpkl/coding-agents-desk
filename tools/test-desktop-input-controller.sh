#!/bin/sh
set -eu

src="$(CDPATH= cd -- "$(dirname -- "$0")/grid-encoder" && pwd)"
out="$(mktemp -d)/desktop-input-controller-tests"
fixtures="$(CDPATH= cd -- "$src/../../agent-feed/wire" && pwd)/contract-fixture.json"

swiftc -O \
  "$src/CursorMirror.swift" \
  "$src/DesktopInputController.swift" \
  "$src/CaptureControlCommand.swift" \
  "$src/DesktopInputControllerTests.swift" \
  -o "$out"
AGENTDESK_CONTROL_FIXTURES="$fixtures" "$out"
