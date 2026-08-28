#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
out="$(mktemp -d)/desktop-navigation-tests"
swiftc -O \
  "$root/tools/grid-encoder/CursorMirror.swift" \
  "$root/tools/grid-encoder/DesktopInputController.swift" \
  "$root/tools/grid-encoder/DesktopSpaces.swift" \
  "$root/tools/grid-encoder/DesktopSpacesObserver.swift" \
  "$root/tools/grid-encoder/DesktopNavigationTests.swift" \
  "$root/host/AgentDeskHost/SkyLightSymbols.swift" \
  "$root/host/AgentDeskHost/DockSwipeEvent.swift" \
  -o "$out"
AGENTDESK_NAVIGATION_FIXTURES="$root/agent-feed/wire/navigation-fixture.json" "$out"
