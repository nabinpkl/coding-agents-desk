#!/bin/sh
# The one compiled piece of the live-tile path, and now of the composer path too.
# Builds a disposable candidate only. `just grid-encoder-install` publishes it
# to the durable runtime without rebuilding or relaunching either app.
#
# `SkyLightSymbols.swift` comes from the host tree on purpose. The helper needs
# the same private-API binding the host uses, and a second copy is how the two
# drift apart on the next macOS release.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/tools/swiftc-cached.sh"
if [ "$#" -gt 1 ]; then
  echo "usage: build-grid-encoder.sh [output-path]" >&2
  exit 64
fi
out="${1:-$root/.build/grid-encoder}"
swiftc_cached "$out" \
  "$root/tools/grid-encoder/main.swift" \
  "$root/tools/grid-encoder/ControlMode.swift" \
  "$root/tools/grid-encoder/DesktopAudit.swift" \
  "$root/tools/grid-encoder/DesktopSpaces.swift" \
  "$root/tools/grid-encoder/DesktopSpacesObserver.swift" \
  "$root/tools/grid-encoder/ComposerAccess.swift" \
  "$root/tools/grid-encoder/CodexAccess.swift" \
  "$root/tools/grid-encoder/ComposerObserver.swift" \
  "$root/tools/grid-encoder/WorkspaceObserver.swift" \
  "$root/tools/grid-encoder/ComposerVerbs.swift" \
  "$root/tools/grid-encoder/DesktopInputController.swift" \
  "$root/tools/grid-encoder/WindowInputVerbs.swift" \
  "$root/tools/grid-encoder/WindowCaptureVerbs.swift" \
  "$root/tools/grid-encoder/CaptureControlCommand.swift" \
  "$root/tools/grid-encoder/CursorMirror.swift" \
  "$root/host/AgentDeskHost/SkyLightSymbols.swift" \
  "$root/host/AgentDeskHost/DockSwipeEvent.swift"
