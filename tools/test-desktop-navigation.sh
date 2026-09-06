#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
. "$root/tools/swiftc-cached.sh"
# Stable path so the compile is cacheable; the binary itself still runs each time.
out="$root/.build/desktop-navigation-tests"
swiftc_cached "$out" \
  "$root/tools/grid-encoder/CursorMirror.swift" \
  "$root/tools/grid-encoder/DesktopInputController.swift" \
  "$root/tools/grid-encoder/DesktopSpaces.swift" \
  "$root/tools/grid-encoder/DesktopSpacesObserver.swift" \
  "$root/tools/grid-encoder/DesktopNavigationTests.swift" \
  "$root/host/AgentDeskHost/SkyLightSymbols.swift" \
  "$root/host/AgentDeskHost/DockSwipeEvent.swift"

AGENTDESK_NAVIGATION_FIXTURES="$root/agent-feed/wire/navigation-fixture.json" "$out"
