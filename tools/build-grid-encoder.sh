#!/bin/sh
# The one compiled piece of the live-tile path, and now of the composer path too.
# Built once and spawned by the sidecar, so changing the TypeScript around it
# never waits on a Swift build and never needs a host relaunch.
#
# `SkyLightSymbols.swift` comes from the host tree on purpose. The helper needs
# the same private-API binding the host uses, and a second copy is how the two
# drift apart on the next macOS release.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/.build/grid-encoder"
mkdir -p "$root/.build"
swiftc -O \
  "$root/tools/grid-encoder/main.swift" \
  "$root/tools/grid-encoder/ControlMode.swift" \
  "$root/tools/grid-encoder/DesktopAudit.swift" \
  "$root/tools/grid-encoder/ComposerAccess.swift" \
  "$root/tools/grid-encoder/CodexAccess.swift" \
  "$root/tools/grid-encoder/ComposerObserver.swift" \
  "$root/tools/grid-encoder/WorkspaceObserver.swift" \
  "$root/tools/grid-encoder/ComposerVerbs.swift" \
  "$root/tools/grid-encoder/DesktopInputController.swift" \
  "$root/tools/grid-encoder/CaptureControlCommand.swift" \
  "$root/tools/grid-encoder/CursorMirror.swift" \
  "$root/host/AgentDeskHost/SkyLightSymbols.swift" \
  -o "$out"
echo "built $out"
