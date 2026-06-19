#!/usr/bin/env bash
set -euo pipefail

patterns=(
  "Dual""Plane"
  "dual""-""plane"
  "Media""Plane"
  "Video""Plane"
  "detail""-""video"
  "motion""-""video"
  "Interaction""Hint"
  "set""Video""Interactive"
  "AGENTDESK""_MEDIA""_STACK"
  "Lib""Web""RTC"
  "RTC""MTL"
  "media""Mode"
  "media""Planes"
  "Web""RTC"
  "web""rtc"
  "motion""Active"
  "scroll""Interaction""Active"
  "Sender""Tuning"
  "Media""Codec""Preferences"
  "Codec""Preference""Policy"
  "Codec""Capability""Descriptor"
  "Sdp""Video""Codec""Inspector"
  "Web""RTC""Signaling""Frame"
  "Media""Transport""Role"
)

args=()
for pattern in "${patterns[@]}"; do
  args+=("-e" "$pattern")
done

if rg -n "${args[@]}" \
  host/AgentDeskHost \
  client/AgentDeskClient \
  host/AgentDeskHostTests \
  client/AgentDeskClientTests \
  SPEC.md \
  PRD.md \
  README.md \
  TASKS.md \
  Justfile \
  .env.example \
  tools \
  --glob '!tools/media-architecture-guard.sh'; then
  echo "Removed media architecture terms found in active source or current docs." >&2
  exit 1
fi
