#!/bin/sh
set -eu

src="$(CDPATH= cd -- "$(dirname -- "$0")/grid-encoder" && pwd)"
out="$(mktemp -d)/desktop-input-controller-tests"
fixtures="$(CDPATH= cd -- "$src/../../agent-feed/wire" && pwd)/contract-fixture.json"
# Routing is asserted against the real ownership sets, which live beside the switches that use
# them, so the navigation subsystem and the host symbols it leans on are compiled in too.
host="$(CDPATH= cd -- "$src/../../host/AgentDeskHost" && pwd)"

swiftc -O \
  "$src/CursorMirror.swift" \
  "$src/DesktopInputController.swift" \
  "$src/CaptureControlCommand.swift" \
  "$src/ControlRouter.swift" \
  "$src/DesktopSpaces.swift" \
  "$src/DesktopSpacesObserver.swift" \
  "$host/SkyLightSymbols.swift" \
  "$host/DockSwipeEvent.swift" \
  "$src/DesktopInputControllerTests.swift" \
  -o "$out"
AGENTDESK_CONTROL_FIXTURES="$fixtures" "$out"
