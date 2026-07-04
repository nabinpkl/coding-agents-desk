# Load the gitignored .env so recipes (notably host-run) can forward
# config such as AGENTDESK_TRANSCRIBE_URL into the launched app without
# the value being hardcoded here. .env.example documents every knob.
set dotenv-load := true

ios_test_destination := env_var_or_default("AGENTDESK_IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPhone 17,OS=latest")
ios_device := env_var_or_default("AGENTDESK_IOS_DEVICE", "93DF5649-FC7B-5460-A6B4-74D2C1CEAB07")
# UDID of the iPhone simulator used for Maestro UI flows. Override via env.
ios_sim_udid := env_var_or_default("AGENTDESK_IOS_SIM_UDID", "00000000-0000-4000-8000-000000000022")
# Second simulator for the dev client, so a full dev stack (dev host + dev client)
# runs on its own sim beside the stable stack. Override via env.
ios_sim_udid_dev := env_var_or_default("AGENTDESK_IOS_SIM_UDID_DEV", "00000000-0000-4000-8000-000000000023")
iphone_log_archive := env_var_or_default("AGENTDESK_IPHONE_LOG_ARCHIVE", "/tmp/agentdesk-client.logarchive")
iphone_log_minutes := env_var_or_default("AGENTDESK_IPHONE_LOG_MINUTES", "5")
iphone_console_log := env_var_or_default("AGENTDESK_IPHONE_CONSOLE_LOG", "/tmp/agentdesk-client-console.log")
sim_console_log := env_var_or_default("AGENTDESK_SIM_CONSOLE_LOG", "/tmp/agentdesk-sim-console.log")
# One-shot motion-verify capture files (see the `motion-verify` recipe). Each leg
# of the round-trip writes to its own durable /tmp file so a run is reproducible
# and needs no live stream to read.
motion_host_oslog := env_var_or_default("AGENTDESK_MOTION_HOST_OSLOG", "/tmp/agentdesk-motion-host-oslog.log")
motion_host_stdio := env_var_or_default("AGENTDESK_MOTION_HOST_STDIO", "/tmp/agentdesk-motion-host-stdio.log")
motion_client_log := env_var_or_default("AGENTDESK_MOTION_CLIENT_LOG", "/tmp/agentdesk-motion-client.log")
iphone_log_device_udid := env_var_or_default("AGENTDESK_IOS_DEVICE_UDID", "")
# Host-written automation files live under the host's Application Support dir,
# which is now rooted on the host bundle id (Config.applicationSupportDirectory).
# Each host variant writes to its own tree, so the recipes select the stable or
# dev pair-url path by variant. host_bundle_id / host_dev_bundle_id are defined
# below (just resolves variables regardless of order).
host_support_dir := env_var_or_default("HOME", "") + "/Library/Application Support/" + host_bundle_id
host_dev_support_dir := env_var_or_default("HOME", "") + "/Library/Application Support/" + host_dev_bundle_id
last_pair_url_path := host_support_dir + "/.last-pair-url"
host_dev_last_pair_url_path := host_dev_support_dir + "/.last-pair-url"
client_diagnostics_request_path := host_support_dir + "/.client-diagnostics-request.json"
client_diagnostics_result_path := host_support_dir + "/.client-diagnostics-result.json"
derived_data := env_var_or_default("AGENTDESK_DERIVED_DATA_PATH", justfile_directory() + "/.build/DerivedData")
host_app := derived_data + "/Build/Products/Debug/AgentDeskHost.app"
client_app := derived_data + "/Build/Products/Debug-iphoneos/AgentDeskClient.app"
client_sim_app := derived_data + "/Build/Products/Debug-iphonesimulator/AgentDeskClient.app"
# Release-configuration product paths, used by the Release feel-test composites
# (fresh-install / sim-fresh-install). xcodebuild writes Release products into a
# separate Products/Release* dir, so these coexist with the Debug builds above.
host_app_release := derived_data + "/Build/Products/Release/AgentDeskHost.app"
client_app_release := derived_data + "/Build/Products/Release-iphoneos/AgentDeskClient.app"
client_sim_app_release := derived_data + "/Build/Products/Release-iphonesimulator/AgentDeskClient.app"
# Two coexisting HOST installs mirroring the client: the stable daily-driver and
# an experimental "dev" host under test. They differ by bundle id (com.example.agentdesk.
# AgentDeskHost / .dev), so each self-namespaces its logs, keychain, Application
# Support state, launchd label, and tier-derived ports (Config.tier) and can run
# CONCURRENTLY. The dev host builds into a SEPARATE derived-data dir: both share
# PRODUCT_NAME (AgentDeskHost.app) so they would otherwise clobber on disk, and
# the distinct path is how the kill step targets one variant without killing the
# other (a bare `pkill -f AgentDeskHost` would kill both). Override ids via env.
host_bundle_id := env_var_or_default("AGENTDESK_HOST_BUNDLE_ID", "com.example.agentdesk.AgentDeskHost")
host_dev_bundle_id := env_var_or_default("AGENTDESK_HOST_DEV_BUNDLE_ID", "com.example.agentdesk.AgentDeskHost.dev")
host_dev_derived_data := derived_data + "-host-dev"
host_dev_app := host_dev_derived_data + "/Build/Products/Debug/AgentDeskHost.app"
host_dev_app_release := host_dev_derived_data + "/Build/Products/Release/AgentDeskHost.app"
# Two coexisting client installs: the stable daily-driver and an experimental
# "dev" build under test. They differ only by bundle id, so iOS keeps both on
# the phone. The dev build outputs to a SEPARATE derived-data dir because both
# variants share PRODUCT_NAME (AgentDeskClient.app) and would otherwise clobber
# each other on disk. The dev bundle id is a HITL-provisioned App ID (AGENTS.md);
# override either id via env. Most client recipes take a `variant` arg
# ("stable" default | "dev"); thin `-dev` wrappers pass it.
client_bundle_id := env_var_or_default("AGENTDESK_CLIENT_BUNDLE_ID", "com.example.agentdesk.AgentDeskClient")
client_dev_bundle_id := env_var_or_default("AGENTDESK_CLIENT_DEV_BUNDLE_ID", "com.example.agentdesk.AgentDeskClient.dev")
dev_derived_data := derived_data + "-dev"
client_dev_app := dev_derived_data + "/Build/Products/Debug-iphoneos/AgentDeskClient.app"
client_sim_dev_app := dev_derived_data + "/Build/Products/Debug-iphonesimulator/AgentDeskClient.app"
client_archive_path := env_var_or_default("AGENTDESK_CLIENT_ARCHIVE_PATH", justfile_directory() + "/.build/testflight/AgentDeskClient.xcarchive")
client_export_path := env_var_or_default("AGENTDESK_CLIENT_EXPORT_PATH", justfile_directory() + "/.build/testflight/export")
client_ipa_path := env_var_or_default("AGENTDESK_CLIENT_IPA_PATH", client_export_path + "/AgentDeskClient.ipa")
# Experimental-variant TestFlight artifact paths, kept separate from the stable
# ones so a dev archive/export never overwrites a stable one. The dev IPA carries
# bundle id {{client_dev_bundle_id}}, which App Store Connect routes to its own
# app record (a bundle id maps to exactly one record; that record is HITL).
client_dev_archive_path := justfile_directory() + "/.build/testflight/AgentDeskClient-dev.xcarchive"
client_dev_export_path := justfile_directory() + "/.build/testflight/export-dev"
client_dev_ipa_path := client_dev_export_path + "/AgentDeskClient.ipa"
# Marketing versions (CFBundleShortVersionString), semver, bumped PER RELEASE not
# per build: MAJOR = incompatible change, MINOR = new feature, PATCH = bug fix.
# Host and client are versioned INDEPENDENTLY (separate release cadences); their
# compatibility is the wire protocol version (Config.protocolVersion), not these
# numbers. The build number is independent (git commit count) and the short git
# sha is embedded, so a build reads as "v1.3.0 (382) c5b4fb2". See AGENTS.md
# "Versioning". History: 1.1.0 = Mac-initiated pairing (ADR-0019); 1.2.0 = live
# tailnet device discovery (R55); 1.3.0 = independent host/client versions +
# protocol-version negotiation (ADR-0020, R56); host 1.4.0 = dev/stable host
# variants, bundle-id-rooted identity, signaling port over the offer (ADR-0037);
# 1.5.0 = input-lane liveness (popover no longer stuck on "Connected") +
# client-initiated unpair (revoke frame).
host_marketing_version := env_var_or_default("AGENTDESK_HOST_VERSION", "1.5.0")
client_marketing_version := env_var_or_default("AGENTDESK_CLIENT_VERSION", "1.7.1")
apple_team_id := env_var_or_default("AGENTDESK_APPLE_TEAM_ID", "TEAMID0000")
# Source directory for the ATC engine. Override via env when the engine repo
# lives somewhere other than the default sibling path. This is the SSOT for
# the engine source location; nothing in source code should hardcode the path.
atc_engine_dir := env_var_or_default("AGENTDESK_ATC_ENGINE_DIR", justfile_directory() + "/../atc/engine")
# Source directory for the ATC dashboard (webview build). Override via env when
# the dashboard lives somewhere other than the default sibling path.
atc_dashboard_dir := env_var_or_default("AGENTDESK_ATC_DASHBOARD_DIR", justfile_directory() + "/../atc/dashboard")
# The sidecar binary is placed alongside the Swift sources in AgentDeskHost/
# so Xcode picks it up as a bundled resource (it is wired into the project's
# Resources build phase). It is loaded at runtime via Config.agentSidecarURL.
sidecar_out := justfile_directory() + "/host/AgentDeskHost/atc-sidecar"
# The webview bundle directory is placed alongside the Swift sources in
# AgentDeskClient/ so Xcode picks it up as a bundled folder resource (wired
# into the project's Resources build phase as a folder reference). It is loaded
# at runtime by the WKWebView (next task) via:
#   Bundle.main.url(forResource: "index", withExtension: "html",
#                   subdirectory: "AgentFeedWebview")
webview_out := justfile_directory() + "/client/AgentDeskClient/AgentFeedWebview"

# Ensure a minimal placeholder exists at the sidecar output path. The real
# ~64 MB binary is gitignored (never tracked), so a fresh checkout has nothing
# there; without a placeholder, Xcode's Copy-Resources phase would fail for a
# path it expects to bundle. This writes a tiny executable stub if and only if
# the path is missing, so it never clobbers a real built binary.
ensure-sidecar-placeholder:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -e '{{sidecar_out}}' ]; then
        printf '#!/bin/sh\necho "atc-sidecar placeholder - run: just build-agent-sidecar" >&2\nexit 1\n' > '{{sidecar_out}}'
        chmod +x '{{sidecar_out}}'
    fi

# Build the ATC engine sidecar into the host app bundle source dir. The result
# is a self-contained executable (~64 MB) that the host spawns at runtime via
# AgentEngineSidecar. It requires bun to be on PATH and OVERWRITES the
# gitignored placeholder in place.
#
# Distribution signing and notarization of this embedded binary is handled at
# DMG packaging time, not here. Local/dev builds run unsigned or with the
# local Developer ID applied during the normal Xcode codesign step.
build-agent-sidecar:
    bun build --compile '{{atc_engine_dir}}/src/server.ts' --outfile '{{sidecar_out}}'

# Build the real engine binary and run AgentEngineSidecar against it, curling
# /api/projects/digest on loopback to confirm the binary integrates end-to-end.
# This is for manual/coordinator verification; it is NOT part of `just check`.
sidecar-smoke: build-agent-sidecar
    #!/usr/bin/env bash
    set -euo pipefail
    PORT=47998
    BINARY='{{sidecar_out}}'
    echo "sidecar-smoke: launching $BINARY on port $PORT"
    ATC_PORT=$PORT ATC_HOST=127.0.0.1 "$BINARY" &
    SPID=$!
    trap "kill $SPID 2>/dev/null; wait $SPID 2>/dev/null" EXIT
    # Poll for up to 10 seconds.
    for i in $(seq 1 100); do
        if curl -sf http://127.0.0.1:$PORT/api/config > /dev/null 2>&1; then break; fi
        sleep 0.1
    done
    # Print a bounded, robust readout. Avoid piping the large digest through a
    # pretty-printer whose blocking stdout write can fail (BlockingIOError) and
    # mask a working integration. curl writes to a file, then we head-truncate.
    CFG=$(curl -sf "http://127.0.0.1:$PORT/api/config")
    echo "sidecar-smoke: /api/config -> ${CFG}"
    DIGEST_FILE=$(mktemp)
    trap "kill $SPID 2>/dev/null; wait $SPID 2>/dev/null; rm -f $DIGEST_FILE" EXIT
    if ! curl -sf "http://127.0.0.1:$PORT/api/projects/digest" -o "$DIGEST_FILE"; then
        echo "sidecar-smoke: FAIL - /api/projects/digest did not respond" >&2
        exit 1
    fi
    BYTES=$(wc -c < "$DIGEST_FILE" | tr -d ' ')
    echo "sidecar-smoke: /api/projects/digest -> ${BYTES} bytes, first 800:"
    head -c 800 "$DIGEST_FILE"
    echo ""
    echo "sidecar-smoke: PASS"

# Ensure a minimal placeholder index.html exists in the webview bundle dir. The
# real bundle (~5 MB) is gitignored; a fresh checkout has only the .gitkeep that
# keeps the directory tracked by git. Without an index.html, Xcode's Copy-Resources
# phase (folder reference) copies an empty directory and the WKWebView (next task)
# would have nothing to load. This writes a tiny stub if and only if the file is
# missing, so it never clobbers a real built bundle.
ensure-webview-placeholder:
    #!/usr/bin/env bash
    set -euo pipefail
    WEBVIEW_INDEX='{{webview_out}}/index.html'
    if [ ! -e "$WEBVIEW_INDEX" ]; then
        mkdir -p '{{webview_out}}'
        printf '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Agent Feed Placeholder</title></head>\n<body>\n<p>agent feed placeholder - run: just build-agent-webview</p>\n</body>\n</html>\n' > "$WEBVIEW_INDEX"
    fi

# Build the ATC dashboard webview bundle into the client app bundle source dir.
# The result is a static file:// loadable directory (index.html + assets/) that
# the WKWebView (next task) loads via Bundle.main. Requires bun to be on PATH.
# OVERWRITES the gitignored placeholder and any prior build in place.
#
# The bundle is loaded by the WKWebView via:
#   Bundle.main.url(forResource: "index", withExtension: "html",
#                   subdirectory: Config.agentFeedWebviewSubdirectory)
# which resolves to AgentFeedWebview/index.html inside the app bundle.
build-agent-webview:
    #!/usr/bin/env bash
    set -euo pipefail
    DASHBOARD='{{atc_dashboard_dir}}'
    OUT='{{webview_out}}'
    echo "build-agent-webview: running bun run webview:build in $DASHBOARD"
    cd "$DASHBOARD" && bun run webview:build
    echo "build-agent-webview: copying webview-dist/ -> $OUT"
    rm -rf "$OUT"
    mkdir -p "$OUT"
    cp -R "$DASHBOARD/webview-dist/." "$OUT/"
    # Re-create the tracked .gitkeep that the rm -rf above removed. It keeps the
    # directory tracked by git so the Xcode folder reference resolves on a fresh
    # checkout; a build must not leave it deleted in git status.
    touch "$OUT/.gitkeep"
    echo "build-agent-webview: DONE"

# Verify the webview bundle was built and landed correctly. Checks that index.html
# and a non-empty assets/ dir are present and that index.html references assets
# by relative path. This is for manual/coordinator verification; it is NOT part
# of `just check` or `just sim-test`.
webview-smoke: build-agent-webview
    #!/usr/bin/env bash
    set -euo pipefail
    OUT='{{webview_out}}'
    echo "webview-smoke: checking $OUT"
    INDEX="$OUT/index.html"
    ASSETS="$OUT/assets"
    if [ ! -f "$INDEX" ]; then
        echo "webview-smoke: FAIL - index.html not found at $INDEX" >&2
        exit 1
    fi
    if [ ! -d "$ASSETS" ] || [ -z "$(ls -A "$ASSETS" 2>/dev/null)" ]; then
        echo "webview-smoke: FAIL - assets/ dir missing or empty at $ASSETS" >&2
        exit 1
    fi
    if ! grep -q '\./assets' "$INDEX"; then
        echo "webview-smoke: FAIL - index.html does not reference assets by relative path (./assets)" >&2
        echo "webview-smoke: index.html head:" >&2
        head -20 "$INDEX" >&2
        exit 1
    fi
    ASSET_COUNT=$(ls "$ASSETS" | wc -l | tr -d ' ')
    INDEX_BYTES=$(wc -c < "$INDEX" | tr -d ' ')
    echo "webview-smoke: index.html ${INDEX_BYTES} bytes, assets/ ${ASSET_COUNT} file(s)"
    echo "webview-smoke: PASS"

# ADR-0038/0039 Phase 1 autonomous gate: hermetic test of the dom-bridge shim against a
# protocol-faithful fake host (token auth + newline JSON), with no Chrome and no Mac host.
# Asserts batch/input round-trips and reconnect. The real DomBridgeServer is covered by the
# Swift DomBridgeServerTests against the same wire contract.
dom-mirror-bridge-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    node '{{justfile_directory()}}/chrome-test/bridge-verify.mjs'

# ADR-0038/0039 Phase 2 autonomous gate + live-Chrome native-messaging manifest-path confirmation.
# Loads the real MV3 extension (rrweb, MAIN-world, masking ON) into a throwaway Chrome profile via
# Playwright, records the CSP-strict fixture through the real connectNative -> shim -> fake host
# chain, and asserts checkout + events + sentinel-present + secret-masked. Uses the globally
# installed Playwright and the system Google Chrome (channel:chrome); no browser download.
dom-mirror-record-verify: ext-stamp
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    node '{{justfile_directory()}}/chrome-test/record-verify.mjs'

# ADR-0040 Phase 5 autonomous gate: the tap-back WRITE path, deterministic, no simulator. A fake host
# sends a dom-input command through the shim to the real extension, which dispatches it as trusted
# input via chrome.debugger; a gated click-report confirms an isTrusted click landed at the mapped
# coordinate. Uses the globally-installed Playwright + Chrome for Testing.
dom-mirror-input-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    node '{{justfile_directory()}}/chrome-test/input-verify.mjs'

# ADR-0047 scroll-drive-back autonomous gate: the scroll WRITE path, deterministic, no simulator. A
# fake host sends a dom-scroll command through the shim to the real extension, which drives the tab to
# scroll via chrome.debugger (Input.synthesizeScrollGesture); the harness reads window.scrollY to
# confirm the live page scrolled in the direction the sign convention promises. Uses the globally
# installed Playwright + Chrome for Testing.
dom-mirror-scroll-verify: ext-stamp
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    node '{{justfile_directory()}}/chrome-test/scroll-verify.mjs'

# ADR-0047 client-gesture autonomous gate: exercises the REAL index.html touch state machine (the
# threshold deadzone, rAF-coalesced scroll posting, tap-vs-scroll suppression, and multi-touch
# deactivation) in a headless browser -- the half the worker-side scroll gate does not cover. No
# extension, no shim, no host; just the webview. Uses the global Playwright + Chrome for Testing.
dom-mirror-scroll-gesture-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    node '{{justfile_directory()}}/chrome-test/scroll-gesture-verify.mjs'

# ADR-0048 device-emulation autonomous gate: the emulate WRITE path + authoritative echo. A fake host
# sends dom-emulate through the shim to the real extension, which device-emulates the recorded tab via
# chrome.debugger and resnapshots; the harness asserts the resulting checkout batch reports the iPhone
# viewport width and carries em:true (desktop restores width + em:false). Uses the global Playwright +
# Chrome for Testing.
dom-mirror-emulate-verify: ext-stamp
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    node '{{justfile_directory()}}/chrome-test/emulate-verify.mjs'

# ADR-0044 Tier B autonomous gate: capture a REAL DOMSnapshot.captureSnapshot (piercing a CLOSED
# shadow root) via Playwright's CDP session, run it through the SAME reconstructMaskedHtml the service
# worker uses, and assert the closed-shadow subtree is captured AND every sensitive value is masked.
# Uses the global Playwright + Chrome for Testing; the extension is not loaded.
dom-mirror-cdp-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    node '{{justfile_directory()}}/chrome-test/cdp-verify.mjs'

# ADR-0038 Phase 4 read-only-v1 acceptance test: the full three-process chain (real host with DOM
# mirror on + paired sim client + real Chrome-for-Testing extension). Chrome records the CSP-strict
# fixture; the batch flows extension -> shim -> host -> .dom QUIC lane -> sim client -> replay
# surface, which emits a probe of the reconstructed DOM. Asserts the sim console shows the capture
# marker (page text is masked, so the probe keys on a data-attribute marker + node count).
# Standing sim + throwaway-Chrome approval covers this (physical device stays a checkpoint).
dom-mirror-e2e: ext-stamp
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    UDID='{{ios_sim_udid}}'
    CONSOLE='{{sim_console_log}}'
    PAIRURL='{{last_pair_url_path}}'
    cleanup() {
      kill "${SIMTEE_PID:-0}" 2>/dev/null || true
      xcrun simctl terminate "$UDID" com.example.agentdesk.AgentDeskClient 2>/dev/null || true
      kill $(pgrep -f AgentDeskHost) 2>/dev/null || true
      for v in AGENTDESK_AUTO_APPROVE AGENTDESK_DEV_PERMISSIVE_KEYSTORE AGENTDESK_DOM_MIRROR_ENABLED; do launchctl unsetenv "$v" 2>/dev/null || true; done
    }
    trap cleanup EXIT

    echo "== build + launch host with DOM mirror enabled =="
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath '{{derived_data}}' MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build >/dev/null
    kill $(pgrep -f AgentDeskHost) 2>/dev/null || true; sleep 1
    launchctl setenv AGENTDESK_AUTO_APPROVE 1
    launchctl setenv AGENTDESK_DEV_PERMISSIVE_KEYSTORE 1
    launchctl setenv AGENTDESK_DOM_MIRROR_ENABLED 1
    open "{{host_app}}"; sleep 3
    pgrep -lf AgentDeskHost >/dev/null || { echo "host did not start"; exit 1; }

    echo "== build + install sim client =="
    just client-sim-reinstall >/dev/null

    echo "== pair + launch sim client with DOM mirror on (console tee) =="
    xcrun simctl bootstatus "$UDID" -b >/dev/null
    rm -f "$PAIRURL" "$CONSOLE"
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "$PAIRURL" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$PAIRURL" || { echo "host did not write pairing URL"; exit 1; }
    ( SIMCTL_CHILD_AGENTDESK_LAUNCH_URL="$(cat "$PAIRURL")" SIMCTL_CHILD_AGENTDESK_DEV_HOST_OVERRIDE=localhost \
        SIMCTL_CHILD_AGENTDESK_DOM_MIRROR_PROBE_STDERR=1 \
        xcrun simctl launch --console --terminate-running-process "$UDID" com.example.agentdesk.AgentDeskClient -agentDesk.domMirrorEnabled YES 2>&1 | tee "$CONSOLE" ) &
    SIMTEE_PID=$!
    echo "waiting for client to connect + open the .dom lane..."; sleep 10

    echo "== drive Chrome: record the fixture through the real chain =="
    node "$ROOT/chrome-test/e2e-chrome.mjs"

    echo "== assert the sim client's DOM-mirror probe shows the capture marker =="
    ok=0
    for i in $(seq 1 20); do
      if grep -q "dom-mirror-probe marker=dommirror-capture-ok" "$CONSOLE"; then ok=1; break; fi
      sleep 1
    done
    if [ "$ok" = "1" ]; then
      echo "dom-mirror-e2e: PASS"; grep "dom-mirror-probe" "$CONSOLE" | tail -2
    else
      echo "dom-mirror-e2e: FAIL - no probe with the capture marker in the sim console"
      echo "--- sim console tail ---"; tail -30 "$CONSOLE" || true
      exit 1
    fi

# Fast correctness gate: guard scripts plus the host build and tests. Excludes
# the client simulator tests, which need a booted simulator and dominate the
# wall-clock (sim boot plus ~18s run). Run those with `just sim-test`, or run
# everything with `just check-all`.
check variant="stable": ensure-sidecar-placeholder
    #!/usr/bin/env bash
    set -euo pipefail
    sh tools/media-architecture-guard.sh
    sh tools/launch-env-tests.sh
    sh tools/hybrid-graphics-diagnostics-summary-tests.sh
    sh tools/testflight-upload-tests.sh
    (cd packages/AgentDeskWire && swift test)
    if [ "{{variant}}" = "dev" ]; then
        DD='{{host_dev_derived_data}}'; EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev)
    else
        DD='{{derived_data}}'; EXTRA=()
    fi
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -derivedDataPath "$DD" ${EXTRA[@]+"${EXTRA[@]}"} build test

# AgentDeskWire package unit tests: the shared wire contract's authoritative
# round-trip suite (ADR-0050). Also run as the first leg of `check`.
wire-test:
    cd packages/AgentDeskWire && swift test

# Client simulator tests. Boots the iPhone simulator and is the slow leg split
# out of `check`. Run before committing client-side changes.
sim-test: ensure-webview-placeholder
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -derivedDataPath '{{derived_data}}' -sdk iphonesimulator -destination '{{ios_test_destination}}' build test

# Full gate: the fast host-side check plus the client simulator tests.
check-all: check sim-test

dev:
    open host/AgentDeskHost.xcodeproj
    open client/AgentDeskClient.xcodeproj

# Stream the host's os_log output live (ctrl-c to stop), echoing to
# the terminal AND appending to /tmp/agentdesk-host.log so an agent
# can read the captured stream back without the user copy-pasting it.
# Truncates the file on each run so each session starts clean.
host-logs:
    : > /tmp/agentdesk-host.log
    log stream --predicate 'subsystem == "com.example.agentdesk.AgentDeskHost"' --info --style compact | tee -a /tmp/agentdesk-host.log

# Pull recent iPhone unified logs for the client into a log archive, then
# print the same filtered view back to the terminal. Device collection
# requires root, so this recipe prompts through sudo for the collect step
# only. By default this uses the first connected device because `log collect`
# does not accept the CoreDevice identifier used by devicectl. Set
# AGENTDESK_IOS_DEVICE_UDID when multiple devices are reachable over USB
# or Wi-Fi.
iphone-log-collect variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then BID='{{client_dev_bundle_id}}'; else BID='{{client_bundle_id}}'; fi
    rm -rf "{{iphone_log_archive}}"
    if [ -n "{{iphone_log_device_udid}}" ]; then
        sudo /usr/bin/log collect --device-udid "{{iphone_log_device_udid}}" --last "{{iphone_log_minutes}}m" --predicate "subsystem == \"$BID\"" --output "{{iphone_log_archive}}"
    else
        sudo /usr/bin/log collect --device --last "{{iphone_log_minutes}}m" --predicate "subsystem == \"$BID\"" --output "{{iphone_log_archive}}"
    fi
    /usr/bin/log show --style compact --info --debug --predicate "subsystem == \"$BID\"" "{{iphone_log_archive}}"

# Build host Debug and (re)launch it via LaunchServices so macOS TCC
# attributes Screen Recording (and any other privacy prompt) to
# AgentDeskHost itself, not to the terminal/IDE that runs this recipe.
# Launching the binary directly from a shell makes TCC walk the spawn
# chain to the responsible GUI ancestor (VS Code, Terminal.app, etc.)
# and prompts for THAT app, which is the bug surfaced during R8.6.5
# bring-up.
#
# Selected AGENTDESK_* env vars are pushed through `launchctl setenv` so
# the launchd-managed GUI launch inherits them. The unsetenv after launch
# keeps the variable from polluting other apps started later in the same
# login session.
#
# AGENTDESK_TRANSCRIBE_URL (and _MODEL) come from .env via dotenv-load
# and are forwarded the same way so dictation has its now-required
# endpoint without a hand-run `launchctl setenv` each launch. The app
# captures its environment at launch, so the post-open unsetenv does not
# disturb the running host. Each var is only unset if we set it, so a
# value the user pinned into launchd out-of-band survives.
#
# AGENTDESK_OWNED_MEDIA_* is forwarded for one-shot owned media feel runs
# with `just fresh-install`. The retained-tile repair knobs are documented
# as AGENTDESK_HYBRID_* in .env.example.
# variant: "stable" (default) or "dev" (the experimental side-by-side host:
# bundle id {{host_dev_bundle_id}}, DEV-badged icon, separate derived-data dir,
# tier-derived ports). The dev host runs concurrently with the stable one.
host-run variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    # DOM mirror (Chrome page mirroring, ADR-0038) is baked on by default for every
    # variant now, so no AGENTDESK_DOM_MIRROR_ENABLED override is injected here; the
    # host's own code default carries it (single source of truth). The native-messaging
    # bridge is wired at the end of this recipe so browser mode works out of the box.
    if [ "{{variant}}" = "dev" ]; then
        DD='{{host_dev_derived_data}}'; APP='{{host_dev_app}}'; SIGPORT=41988
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev)
    else
        DD='{{derived_data}}'; APP='{{host_app}}'; SIGPORT=41888
        EXTRA=()
    fi
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath "$DD" MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" ${EXTRA[@]+"${EXTRA[@]}"} build >/dev/null
    # Kill only THIS variant's running host, matched by its derived-data path, so
    # relaunching one variant never kills the other (concurrent stacks).
    pkill -f "$DD/Build/Products/.*/AgentDeskHost" 2>/dev/null || true
    # Backstop: a host from a DIFFERENT checkout has the same bundle id but a
    # different derived-data path, so the pkill above misses it and the two stacks
    # collide on the signaling port. Also kill whoever holds THIS variant's port.
    # Scoped to the tier-derived port (env override honored, matching Config), so
    # the sibling variant on its own port is never touched.
    SIGPORT="${AGENTDESK_SIGNALING_PORT:-$SIGPORT}"
    PORT_PIDS=$(lsof -ti tcp:"$SIGPORT" 2>/dev/null || true)
    [ -n "$PORT_PIDS" ] && kill $PORT_PIDS 2>/dev/null || true
    sleep 1
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 tools/launch-env.sh set
    open "$APP"
    sleep 2
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 tools/launch-env.sh unset
    pgrep -lf "$DD/Build/Products/.*/AgentDeskHost" || true
    # DOM bridge is first-class: wire this variant's native-messaging manifest on every
    # launch so the Chrome extension can reach the running host. Non-fatal so a host run
    # never blocks on Chrome/node config; it warns loudly instead of failing silently.
    just dom-bridge-reinstall {{variant}} || echo "WARN: dom-bridge wiring failed; browser mode will not mirror until 'just dom-bridge-reinstall {{variant}}' succeeds"

# Release-configuration twin of host-run: same kill + rebuild + relaunch lifecycle,
# but -configuration Release so the host runs at shipped-build performance. A Debug
# (-Onone) host pegs a core in the crisp tile codec (OwnedTileCodec.extractTileWithHash
# per-byte Range loops); Release optimizes that away (~100% -> ~30% CPU). Used by the
# fresh-install / sim-fresh-install feel-test composites. Every other host launch
# (plain host-run, motion-verify, agent-feed-sim) stays Debug for fast iteration.
host-run-release variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    # DOM mirror is baked on by default (see host-run); no enable override injected here.
    if [ "{{variant}}" = "dev" ]; then
        DD='{{host_dev_derived_data}}'; APP='{{host_dev_app_release}}'; SIGPORT=41988
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev)
    else
        DD='{{derived_data}}'; APP='{{host_app_release}}'; SIGPORT=41888
        EXTRA=()
    fi
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Release -derivedDataPath "$DD" MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" ${EXTRA[@]+"${EXTRA[@]}"} build >/dev/null
    # Path-scoped kill: only THIS variant's host from THIS checkout (see host-run).
    pkill -f "$DD/Build/Products/.*/AgentDeskHost" 2>/dev/null || true
    # Backstop: kill a same-bundle-id host from a different checkout that holds this
    # variant's signaling port (the path-scoped pkill misses it). Port-scoped, so the
    # sibling variant on its own tier-derived port is untouched.
    SIGPORT="${AGENTDESK_SIGNALING_PORT:-$SIGPORT}"
    PORT_PIDS=$(lsof -ti tcp:"$SIGPORT" 2>/dev/null || true)
    [ -n "$PORT_PIDS" ] && kill $PORT_PIDS 2>/dev/null || true
    sleep 1
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 tools/launch-env.sh set
    open "$APP"
    sleep 2
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 tools/launch-env.sh unset
    pgrep -lf "$DD/Build/Products/.*/AgentDeskHost" || true
    # DOM bridge first-class: wire this variant's native-messaging manifest on every launch.
    just dom-bridge-reinstall {{variant}} || echo "WARN: dom-bridge wiring failed; browser mode will not mirror until 'just dom-bridge-reinstall {{variant}}' succeeds"

# Build client Debug for the iPhone and install (does not launch).
# variant: "stable" (default) or "dev" (the experimental side-by-side install:
# bundle id {{client_dev_bundle_id}}, DEV icon, "AgentDesk Dev" name, separate
# build dir). The dev variant overrides the three identity build settings inline.
client-install variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then
        xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath '{{dev_derived_data}}' -destination 'platform=iOS,id={{ios_device}}' PRODUCT_BUNDLE_IDENTIFIER='{{client_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev BUNDLE_DISPLAY_NAME='AgentDesk Dev' build >/dev/null
        xcrun devicectl device install app --device {{ios_device}} '{{client_dev_app}}'
    else
        xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath '{{derived_data}}' -destination 'platform=iOS,id={{ios_device}}' build >/dev/null
        xcrun devicectl device install app --device {{ios_device}} '{{client_app}}'
    fi

# Uninstall + clean install. iOS caches device-family and other bundle
# metadata for an installed bundle id; rebuilding alone does not flush
# that cache. Use this after changes to TARGETED_DEVICE_FAMILY,
# UIRequires*, or anything else iOS reads at install time.
client-reinstall variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then BID='{{client_dev_bundle_id}}'; else BID='{{client_bundle_id}}'; fi
    xcrun devicectl device uninstall app --device {{ios_device}} "$BID" 2>/dev/null || true
    just client-install {{variant}}

# Release-configuration client build for the iPhone + install (stable only; the
# experimental dev side-by-side variant stays Debug). Device install uses the same
# automatic development signing as the Debug path, so no distribution provisioning
# is needed. Used by the fresh-install feel-test composite.
client-install-release:
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Release -derivedDataPath '{{derived_data}}' -destination 'platform=iOS,id={{ios_device}}' build >/dev/null
    xcrun devicectl device install app --device {{ios_device}} '{{client_app_release}}'

# Uninstall + clean Release install on the iPhone (stable). Mirrors client-reinstall
# but for the Release build; the uninstall flushes install-time bundle metadata.
client-reinstall-release:
    xcrun devicectl device uninstall app --device {{ios_device}} '{{client_bundle_id}}' 2>/dev/null || true
    just client-install-release

# Trigger pairing without scanning the QR. Sends SIGUSR1 to the running host
# (which mints a fresh URL and writes it to {{last_pair_url_path}}), then
# launches the iPhone client with the URL as a CommandLine argument so
# SceneDelegate routes it via handleIncomingPairingURL. The user just runs
# this; no menubar click, no camera, no manual paste.
pair-iphone variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    # dev client pairs with the dev host, which writes its pair URL under its own
    # bundle-id Application Support tree; read that variant's path.
    # dev pairs with the dev host; it also enables the Chrome DOM mirror on the client
    # (ADR-0038), matching the dev host default set by host-run. devicectl apps get env
    # not argv, so the client reads AGENTDESK_DOM_MIRROR_ENABLED via the CHILD prefix.
    if [ "{{variant}}" = "dev" ]; then BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    rm -f "$PAIR_URL"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "$PAIR_URL" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$PAIR_URL" || { echo "host did not write pairing URL"; exit 1; }
    echo "URL: <redacted; delivered to client>"
    URL="$(cat "$PAIR_URL")"; env DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" ${DOM_ENV[@]+"${DOM_ENV[@]}"} xcrun devicectl device process launch --device {{ios_device}} --terminate-existing "$BID"

# Ask the running host to collect durable client diagnostics and write them under
# /tmp. Uses the active QUIC input lane first and falls back to the foreground
# tailnet control listener if the client is paired but not currently connected.
# The variant arg is kept for symmetry with other device-facing recipes even
# though the host resolves the actual client from the live session / tailnet.
client-diagnostics variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    HOST_PID="$(pgrep -f AgentDeskHost | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    TS="$(date +%Y%m%d-%H%M%S)"
    OUT_DIR="${AGENTDESK_CLIENT_DIAGNOSTICS_OUTPUT:-/tmp/agentdesk-client-diagnostics-$TS}"
    REQUEST_ID="$(uuidgen | tr 'A-Z' 'a-z')"
    mkdir -p "$(dirname '{{client_diagnostics_request_path}}')"
    rm -f '{{client_diagnostics_request_path}}' '{{client_diagnostics_result_path}}'
    printf '%s\n' "{\"requestId\":\"$REQUEST_ID\",\"outputDirectory\":\"$OUT_DIR\",\"includePreviousRuns\":true,\"maxBytes\":786432}" > '{{client_diagnostics_request_path}}'
    kill -USR2 "$HOST_PID"
    i=0
    while [ ! -s '{{client_diagnostics_result_path}}' ] && [ $i -lt 400 ]; do sleep 0.1; i=$((i+1)); done
    test -s '{{client_diagnostics_result_path}}' || { echo "host did not write diagnostics result"; exit 1; }
    python3 -c 'import json,sys; path="{{client_diagnostics_result_path}}"; data=json.load(open(path, "r", encoding="utf-8")); print(json.dumps(data, indent=2, sort_keys=True)); sys.exit(0 if data.get("status") == "ok" else 1)'
    echo "Diagnostics directory: $OUT_DIR"

# Pair-launch the physical iPhone client with the console attached. Blocks until
# the app exits and tees stdout/stderr to {{iphone_console_log}}. Owned-media stderr
# tracing is enabled so packet-repair diagnostics have a path separate from iOS
# unified logging. variant: stable (default) | dev.
iphone-console-run variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    # dev also enables the Chrome DOM mirror on the client (ADR-0038), matching the dev
    # host default; devicectl apps get env not argv, so it rides the CHILD prefix.
    if [ "{{variant}}" = "dev" ]; then BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    rm -f "$PAIR_URL" "{{iphone_console_log}}"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "$PAIR_URL" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$PAIR_URL" || { echo "host did not write pairing URL"; exit 1; }
    echo "URL: <redacted; delivered to client>"
    URL="$(cat "$PAIR_URL")"; VIDEO="${AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED:-1}"; env DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1" DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED="$VIDEO" ${DOM_ENV[@]+"${DOM_ENV[@]}"} xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing "$BID" 2>&1 | tee "{{iphone_console_log}}"

# Install the native-messaging manifest that lets the loaded Chrome extension spawn the dom-bridge
# shim and reach the running host (ADR-0039). Required ONCE per real Chrome profile before any
# dom-mirror run shows anything -- without it connectNative finds no host and the mirror stays white.
# (The dom-mirror-*-verify / -e2e recipes only install into throwaway Chrome-for-Testing profiles,
# never your real Chrome.) The ext id is derived from the extension's pinned manifest key
# (chrome-test/ext-id.mjs), so a load-unpacked extension matches without hardcoding the id. The shim
# is pointed at the chosen host's bundle-id-derived socket/token EXPLICITLY, because the shim's own
# default (~/Library/Application Support/AgentDesk/) predates the bundle-id migration and matches no
# current host. variant: dev (default -- the DOM-mirror dev stack) | stable. channel: chrome
# (default) | canary | chromium. Writes to ~/Library/Application Support/Google/<channel>/
# NativeMessagingHosts/; undo with `just dom-bridge-uninstall`.
# Stamp the extension with its git build identity (chrome-extension/build-info.json) so the toolbar
# popup shows exactly which build is loaded -- the extension parallel of the host/client
# AgentDeskGitSHA. An unpacked extension runs whatever is on disk at reload time, so the manifest
# `version` alone can't tell you whether you reloaded after an edit; the sha can. build-info.json is
# gitignored and regenerated here; reload the extension after stamping to pick it up. `dirty` flags
# uncommitted edits under chrome-extension/ so a felt read is never silently against an unshipped
# diff. The marketing version is read from manifest.json (its `version` is the single source of
# truth); bump that per release -- feature -> minor, fix -> patch (see AGENTS.md "Versioning").
ext-stamp:
    #!/usr/bin/env bash
    set -euo pipefail
    cd '{{justfile_directory()}}'
    VER="$(node -p "require('./chrome-extension/manifest.json').version")"
    SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
    COMMITS="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
    if [ -n "$(git status --porcelain chrome-extension 2>/dev/null)" ]; then DIRTY=true; else DIRTY=false; fi
    printf '{\n  "version": "%s",\n  "commits": %s,\n  "sha": "%s",\n  "dirty": %s\n}\n' \
        "$VER" "$COMMITS" "$SHA" "$DIRTY" > chrome-extension/build-info.json
    echo "stamped chrome-extension/build-info.json -> v$VER ($COMMITS) $SHA dirty=$DIRTY"

dom-bridge-install variant="dev" channel="chrome": ext-stamp
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then SUPPORT="$HOME/Library/Application Support/{{host_dev_bundle_id}}"; else SUPPORT="$HOME/Library/Application Support/{{host_bundle_id}}"; fi
    EXT_ID="$(node chrome-test/ext-id.mjs)"
    echo "installing dom-bridge NM manifest: ext=$EXT_ID channel={{channel}} host-socket=$SUPPORT"
    node dom-bridge/install.mjs --ext-id "$EXT_ID" --channel {{channel}} \
        --socket "$SUPPORT/ad-dom-bridge.sock" \
        --token  "$SUPPORT/ad-dom-bridge-token"
    echo "done (extension stamped). Reload the extension in chrome://extensions if it was already running."

# Remove the dom-bridge native-messaging manifest + wrapper (channel: chrome default).
dom-bridge-uninstall channel="chrome":
    node dom-bridge/install.mjs --remove --channel {{channel}}

# Uninstall + fresh install of the dom-bridge manifest, so each run starts from a clean
# bridge (mirrors client-install -> client-reinstall). The fresh sim composites call this
# so a stale manifest (e.g. pointing at the other variant's host socket from a previous
# run) never lingers. variant: dev (default) | stable; channel: chrome (default).
dom-bridge-reinstall variant="dev" channel="chrome":
    -just dom-bridge-uninstall {{channel}}
    just dom-bridge-install {{variant}} {{channel}}

# Clean DOM-mirror simulator run for the LATEST code (dev stack, non-blocking). One command to get
# the whole Chrome-mirror chain up on the sim:
#   1. host-run dev        -- kill + rebuild + relaunch the DEV host with the DOM mirror +
#                             auto-approve + permissive-keystore envs baked into the launched
#                             process (launch-env.sh set -> open -> unset; nothing lingers in launchd)
#   2. dom-bridge-reinstall dev -- (re)point the extension native-messaging manifest at the DEV
#                             host's socket, from clean, so a stale manifest never lingers
#   3. client-sim-reinstall dev -- rebuild + reinstall the DEV sim client
#   4. pair-sim dev        -- pair + launch the DEV sim client with the DOM mirror on
# Rebuilds host + client every run, so it always reflects the latest code. Leaves everything
# running and RETURNS (does not attach a console): then load/reload the extension in Chrome
# (chrome://extensions), start recording a tab from the popup, and drive the mirror on the sim.
# Runs the DEV stack only, so the stable daily-driver host/client are untouched. channel: the
# browser channel the bridge manifest targets (chrome default).
# Clean DEV DOM-mirror sim bring-up for the latest code (non-blocking): dev host + bridge + sim client + pair.
dom-mirror-sim channel="chrome":
    just host-run dev
    just dom-bridge-reinstall dev {{channel}}
    just client-sim-reinstall dev
    just pair-sim dev

# ADR-0038..0041 physical-device run of the Chrome DOM mirror -- the one human checkpoint. Builds
# Release host+client with real artifacts, enables the DOM mirror on BOTH sides (host via launchd
# env; client via the devicectl env path, since devicectl apps get env not argv), pairs, and attaches
# the console. Once it is up: open a Chrome tab that the extension is recording, and the mirror
# appears on the phone; tap the mirror to drive Chrome. Installs on / launches the PHYSICAL iPhone --
# a STOP-and-wait checkpoint. dom-mirror-device-run-dev is the Debug/AgentDesk-Dev twin.
dom-mirror-device-run:
    #!/usr/bin/env bash
    set -euo pipefail
    just build-agent-sidecar
    just build-agent-webview
    launchctl setenv AGENTDESK_DOM_MIRROR_ENABLED 1
    trap 'launchctl unsetenv AGENTDESK_DOM_MIRROR_ENABLED 2>/dev/null || true' EXIT
    just host-run-release
    just client-reinstall-release
    test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running"; exit 1; }
    BID='{{client_bundle_id}}'
    rm -f "{{last_pair_url_path}}" "{{iphone_console_log}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    URL="$(cat "{{last_pair_url_path}}")"
    DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" \
      DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED="1" \
      DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1" \
      xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing "$BID" 2>&1 | tee "{{iphone_console_log}}"

# Dev-variant twin of dom-mirror-device-run. The dev client side-by-side install has no
# Release build path (client-reinstall-release is stable-only), so this stays Debug on
# both host and client -- same shape as fresh-install-dev vs fresh-install. Runs against
# the AgentDesk Dev app/host, pairing URL under the dev host's own Application Support
# tree. Installs on / launches the PHYSICAL iPhone -- a STOP-and-wait checkpoint.
dom-mirror-device-run-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    just build-agent-sidecar
    just build-agent-webview
    launchctl setenv AGENTDESK_DOM_MIRROR_ENABLED 1
    trap 'launchctl unsetenv AGENTDESK_DOM_MIRROR_ENABLED 2>/dev/null || true' EXIT
    just host-run dev
    just client-reinstall dev
    test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running"; exit 1; }
    BID='{{client_dev_bundle_id}}'
    rm -f "{{host_dev_last_pair_url_path}}" "{{iphone_console_log}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "{{host_dev_last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "{{host_dev_last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    URL="$(cat "{{host_dev_last_pair_url_path}}")"
    DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" \
      DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED="1" \
      DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1" \
      xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing "$BID" 2>&1 | tee "{{iphone_console_log}}"

# Physical-device feel/diagnostic runs. Two launch modes x two client variants. All
# rebuild and relaunch the host and reinstall the client (the "fresh" prefix is the
# reinstall). They differ in how the client is launched and in build configuration:
#   fresh-install                  Release host + client, no console, returns ("just use it")
#   fresh-release-diagnostic-run   Release host + client, console attached, blocks and tees the log
# The stable pair builds -configuration Release so a feel or media-diagnosis read
# reflects shipped performance; a Debug (-Onone) host pegs a core in the crisp tile codec
# and distorts the very motion you are judging. The -dev twins (fresh-install-dev,
# fresh-diagnostic-run-dev) stay Debug: the side-by-side AgentDesk Dev build is for fast,
# breakpoint-friendly iteration on risky changes. Suffix -dev to drive that build.
# fresh-release-diagnostic-run is the AGENTS.md default for feel/diagnostic work.
# (There is no detached-console composite on purpose: a backgrounded console grows
# {{iphone_console_log}} unbounded with no teardown. For bounded background capture
# use `motion-verify`, which tears the stream down after a fixed window.)
#
# Each first builds the REAL agent-feed artifacts the app bundles -- the compiled
# Bun engine sidecar (host resource) and the Vite webview bundle (client resource)
# -- so the phone agent surface serves real projects/threads, not the build
# placeholder. Without these the device shows an empty "No projects yet" feed.
# (This mirrors what agent-feed-sim / agent-feed-sim-pair do for the simulator.)
fresh-install:
    just build-agent-sidecar
    just build-agent-webview
    just host-run-release
    just client-reinstall-release
    just pair-iphone stable

fresh-install-dev:
    just build-agent-sidecar
    just build-agent-webview
    just host-run dev
    just client-reinstall dev
    just pair-iphone dev

fresh-release-diagnostic-run:
    just build-agent-sidecar
    just build-agent-webview
    just host-run-release
    just client-reinstall-release
    just iphone-console-run stable

fresh-diagnostic-run-dev:
    just build-agent-sidecar
    just build-agent-webview
    just host-run dev
    just client-reinstall dev
    just iphone-console-run dev

# One-shot, deterministic motion-carrier device verification (ADR-0025). Rebuilds
# and reinstalls host + client, launches both with the motion flag on, records
# every leg of the round-trip to its own durable /tmp file, holds a fixed window
# for you to scroll, then tears the capture down. No live stream to babysit and no
# launchctl: the host GUI app gets its env and stdio straight from
# `open --env/--stdout/--stderr`, and its os_log diagnostics are recorded to a file
# by a recipe-managed `log stream` started before launch (so "datagram server
# started" is captured) and killed at the end. Config comes from .env (dotenv-load)
# plus the inline flags below.
#
#   variant : stable (default) | dev   which client bundle to drive
#   video   : 1 (default) | 0          AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED on both ends
#   seconds : 60 (default)             capture window; scroll a window during it
#
# Durable logs (overridable via env):
#   {{motion_host_oslog}}   host os_log (owned-media diagnostics)
#   {{motion_host_stdio}}   host stdout + stderr (prints, crashes)
#   {{motion_client_log}}   attached client console (stderr traces)
# One-shot motion-carrier device verification: rebuild+reinstall both ends, scroll, durable /tmp logs.
motion-verify variant="dev" video="1" seconds="60":
    #!/usr/bin/env bash
    set -uo pipefail
    HOST_BIN_PAT="Contents/MacOS/AgentDeskHost"
    LOG_PID=""; CONSOLE_PID=""
    cleanup() {
        [ -n "$LOG_PID" ] && kill "$LOG_PID" 2>/dev/null || true
        [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null || true
        pkill -f "devicectl device process launch" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    : > "{{motion_host_oslog}}"; : > "{{motion_host_stdio}}"; : > "{{motion_client_log}}"
    if [ "{{variant}}" = "dev" ]; then BID='{{client_dev_bundle_id}}'; else BID='{{client_bundle_id}}'; fi

    echo "== [1/5] build host =="
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath '{{derived_data}}' MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build >/dev/null

    echo "== [2/5] build + install client ($BID) =="
    just client-install {{variant}}

    echo "== [3/5] launch host (motion={{video}}), capture stdio + os_log =="
    # Clear a stale host and any leftover capture stream from a crashed prior run.
    pkill -f "$HOST_BIN_PAT" 2>/dev/null || true
    pkill -f 'log stream.*dev[.]dev[.]AgentDeskHost' 2>/dev/null || true
    sleep 1
    # Start the os_log capture BEFORE launch so the listener/server-started lines land.
    log stream --predicate 'subsystem == "com.example.agentdesk.AgentDeskHost"' --info --debug --style compact >"{{motion_host_oslog}}" 2>&1 &
    LOG_PID=$!
    sleep 1
    # `open --env` delivers config to the GUI app directly (no launchctl); --stdout/--stderr
    # capture its stdio. Forward EVERY AGENTDESK_* var from this recipe's environment
    # (.env via dotenv-load, plus the three defaults below), so the host sees the same
    # config the current code expects, not a hand-picked subset.
    export AGENTDESK_AUTO_APPROVE=1
    export AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1
    export AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED={{video}}
    HOST_ENV_ARGS=()
    while IFS= read -r kv; do HOST_ENV_ARGS+=( --env "$kv" ); done < <(env | grep '^AGENTDESK_')
    echo "forwarding $(env | grep -c '^AGENTDESK_') AGENTDESK_* vars to host"
    open --stdout "{{motion_host_stdio}}" --stderr "{{motion_host_stdio}}" "${HOST_ENV_ARGS[@]}" "{{host_app}}"
    HOST_PID=""; i=0
    while [ -z "$HOST_PID" ] && [ $i -lt 100 ]; do HOST_PID="$(pgrep -f "$HOST_BIN_PAT" | head -1)"; sleep 0.1; i=$((i+1)); done
    test -n "$HOST_PID" || { echo "host did not start"; exit 1; }
    # Wait until the host finishes launching before signaling it. SIGUSR1's default
    # disposition is terminate, so signaling before the host installs its handler kills
    # it. installPairingSignalHandler() runs early in applicationDidFinishLaunching,
    # well before "signaling server started" is logged, so that line is a safe gate.
    i=0; while ! grep -q "signaling server started" "{{motion_host_oslog}}" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    grep -q "signaling server started" "{{motion_host_oslog}}" 2>/dev/null || { echo "host did not finish launching"; exit 1; }
    echo "host pid=$HOST_PID  os_log-stream pid=$LOG_PID"

    echo "== [4/5] pair + attach client console ($BID) =="
    rm -f "{{last_pair_url_path}}"
    trap 'rm -f "{{last_pair_url_path}}"' EXIT
    kill -USR1 "$HOST_PID"
    i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    URL="$(cat "{{last_pair_url_path}}")"
    echo "pair URL: <redacted; delivered to client>"
    # Forward launch URL + stderr trace + motion flag, plus every
    # AGENTDESK_OWNED_MEDIA_* knob from .env so the on-device client matches current code.
    export DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL"
    export DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1"
    export DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED="{{video}}"
    while IFS='=' read -r k v; do
        case "$k" in AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED|AGENTDESK_OWNED_MEDIA_STDERR_TRACE) continue;; esac
        export "DEVICECTL_CHILD_$k=$v"
    done < <(env | grep '^AGENTDESK_OWNED_MEDIA_')
    echo "client launch env: <redacted launch URL; media knobs forwarded>"
    xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing \
        "$BID" >"{{motion_client_log}}" 2>&1 &
    CONSOLE_PID=$!

    echo "== [5/5] capturing for {{seconds}}s -- SCROLL A WINDOW NOW =="
    sleep {{seconds}}

    cleanup
    trap - EXIT INT TERM
    echo ""
    echo "== done. host left running (pid $HOST_PID). durable logs: =="
    echo "  host os_log : {{motion_host_oslog}}"
    echo "  host stdio  : {{motion_host_stdio}}"
    echo "  client      : {{motion_client_log}}"

# Build client Debug for the iPhone simulator and install (does not launch).
# Mirrors `client-install` but targets the simulator instead of the
# physical device.
# variant: stable (default) | dev. The dev variant builds the dev-bundle-id client
# (DEV icon, separate derived-data) onto the dev simulator ({{ios_sim_udid_dev}}),
# so a full dev stack (dev host + dev client) runs beside the stable stack.
client-sim-install variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then
        SIM='{{ios_sim_udid_dev}}'; DD='{{dev_derived_data}}'; APP='{{client_sim_dev_app}}'
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{client_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev BUNDLE_DISPLAY_NAME='AgentDesk Dev')
    else
        SIM='{{ios_sim_udid}}'; DD='{{derived_data}}'; APP='{{client_sim_app}}'
        EXTRA=()
    fi
    xcrun simctl bootstatus "$SIM" -b >/dev/null
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath "$DD" -sdk iphonesimulator -destination "platform=iOS Simulator,id=$SIM" ${EXTRA[@]+"${EXTRA[@]}"} build >/dev/null
    xcrun simctl install "$SIM" "$APP"

# Uninstall + clean install on the simulator. Same reasoning as
# `client-reinstall`: install-time bundle metadata (UILaunchScreen,
# TARGETED_DEVICE_FAMILY) is cached by the simulator and not flushed
# by a plain rebuild. variant: stable (default) | dev.
client-sim-reinstall variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then SIM='{{ios_sim_udid_dev}}'; BID='{{client_dev_bundle_id}}'; else SIM='{{ios_sim_udid}}'; BID='{{client_bundle_id}}'; fi
    xcrun simctl uninstall "$SIM" "$BID" 2>/dev/null || true
    just client-sim-install {{variant}}

# Release-configuration twins of client-sim-install / client-sim-reinstall, used by
# the sim-fresh-install feel-test composite. No signing concerns on the simulator.
client-sim-install-release:
    xcrun simctl bootstatus {{ios_sim_udid}} -b >/dev/null
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Release -derivedDataPath '{{derived_data}}' -sdk iphonesimulator -destination 'platform=iOS Simulator,id={{ios_sim_udid}}' build >/dev/null
    xcrun simctl install {{ios_sim_udid}} "{{client_sim_app_release}}"

client-sim-reinstall-release:
    -xcrun simctl uninstall {{ios_sim_udid}} com.example.agentdesk.AgentDeskClient 2>/dev/null || true
    just client-sim-install-release

# Simulator equivalent of `pair-iphone`. RELAUNCH + RE-PAIR ONLY: this does
# NOT build or install -- it re-pairs and `simctl launch`es whatever client
# binary is ALREADY installed on the sim. To test a CODE change you must build
# + install first (client-sim-reinstall), or use a full bring-up
# (sim-fresh-install / agent-feed-sim[-pair]). Running pair-sim alone after
# editing code silently exercises the stale installed binary.
# Asks the running host to mint a fresh pair URL (SIGUSR1 -> writes to
# {{last_pair_url_path}}), then launches the app with two env vars:
#   AGENTDESK_LAUNCH_URL -- SceneDelegate reads this and routes through
#     handleIncomingPairingURL on launch (same path as openurl).
#   AGENTDESK_DEV_HOST_OVERRIDE=localhost -- PairingClient swaps the
#     Tailnet FQDN / IPv4 for localhost (simulator-only code path) so
#     the handshake reaches the host through the loopback interface.
#     Without this the simulator times out at NSURLError -1001 because
#     it cannot resolve or route to *.ts.net hostnames without
#     Tailscale running inside the simulator sandbox.
# simctl propagates SIMCTL_CHILD_*-prefixed caller env into the app's
# ProcessInfo.environment.
pair-sim variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    # dev sim pairs with the dev host, which mints its pair URL under its own
    # bundle-id Application Support tree; read that variant's path and sim.
    # dev sim pairs with the dev host and enables the Chrome DOM mirror on the client
    # (ADR-0038), matching the dev host default; simctl forwards it via the CHILD prefix.
    if [ "{{variant}}" = "dev" ]; then SIM='{{ios_sim_udid_dev}}'; BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(SIMCTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else SIM='{{ios_sim_udid}}'; BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    rm -f "$PAIR_URL"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "$PAIR_URL" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$PAIR_URL" || { echo "host did not write pairing URL"; exit 1; }
    echo "URL: <redacted; delivered to simulator>"
    xcrun simctl bootstatus "$SIM" -b >/dev/null
    env SIMCTL_CHILD_AGENTDESK_LAUNCH_URL="$(cat "$PAIR_URL")" \
        SIMCTL_CHILD_AGENTDESK_DEV_HOST_OVERRIDE=localhost \
        ${DOM_ENV[@]+"${DOM_ENV[@]}"} \
        xcrun simctl launch --terminate-running-process "$SIM" "$BID"

# Pair-launch the simulator client with stdout/stderr attached. This is
# the simulator mirror of `iphone-console-run`: it blocks until the app exits
# and tees owned-media stderr traces into {{sim_console_log}}. Maestro flows
# used with this recipe must not include `launchApp`, because relaunching the
# app drops the explicit pairing URL and simulator-only localhost override.
# variant: stable (default) | dev. dev targets the dev sim + dev bundle + dev host
# pair URL and enables the Chrome DOM mirror on the client (ADR-0038), matching the
# dev host default set by host-run.
sim-console-run variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    if [ "{{variant}}" = "dev" ]; then SIM='{{ios_sim_udid_dev}}'; BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(SIMCTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else SIM='{{ios_sim_udid}}'; BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    rm -f "$PAIR_URL" "{{sim_console_log}}"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 $(pgrep -f AgentDeskHost)
    i=0; while [ ! -s "$PAIR_URL" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$PAIR_URL" || { echo "host did not write pairing URL"; exit 1; }
    echo "URL: <redacted; delivered to simulator>"
    xcrun simctl bootstatus "$SIM" -b >/dev/null
    URL="$(cat "$PAIR_URL")"; env SIMCTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" SIMCTL_CHILD_AGENTDESK_DEV_HOST_OVERRIDE=localhost SIMCTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE=1 ${DOM_ENV[@]+"${DOM_ENV[@]}"} xcrun simctl launch --console --terminate-running-process "$SIM" "$BID" 2>&1 | tee "{{sim_console_log}}"

# Point the sim at a host you started yourself (a Release build, or any host
# launched outside `just host-run`): every full composite (sim-fresh-install /
# agent-feed-sim[-pair]) calls host-run, which kills + rebuilds + relaunches the
# host and would clobber the one you launched, so this one deliberately omits it.
# Requires a host process to already be running (pair-sim SIGUSR1s it to mint the
# pair URL); only the client is rebuilt and reinstalled.
# Reinstall the simulator client and pair it to the already-running host (no host rebuild).
sim-reinstall-pair:
    just client-sim-reinstall
    just pair-sim

# Rebuild and relaunch the Mac host and uninstall/reinstall the simulator app in
# Release (-configuration Release, host and client), then pair-launch with stdout/stderr
# attached (owned-media traces -> {{sim_console_log}}). This is the default simulator
# feel-test path; Release so it reflects shipped performance (a Debug -Onone host pegs a
# core in the crisp tile codec). The uninstall wipes UserDefaults so pairing is always
# re-done. For a non-blocking paired launch (e.g. to drive a Maestro flow while the app
# stays open), run the Release leaves host-run-release, client-sim-reinstall-release,
# pair-sim (or the Debug leaves host-run, client-sim-reinstall, pair-sim for fast iteration).
sim-fresh-install:
    just host-run-release
    just client-sim-reinstall-release
    just dom-bridge-reinstall stable
    just sim-console-run

# DISTINCTION: agent-feed-sim BLOCKS with an attached console (use it to watch
# host/client traces live); agent-feed-sim-pair RETURNS (use it to then drive
# the app with `just ui-flow`). Both do a real build+install of host AND client;
# pair-sim does NOT (relaunch only); sim-fresh-install builds host+client but
# bundles the artifact placeholders, not the real sidecar/webview.
#
# Full agent-feed end-to-end simulator bring-up, blocking (attached console).
# Unlike sim-fresh-install, this first builds the REAL agent-feed artifacts the
# app bundles -- the compiled Bun engine sidecar (host resource) and the Vite
# webview bundle (client resource) -- so the agent surface serves real data
# instead of the build-placeholder. Then it kills+rebuilds+relaunches the host,
# uninstalls+rebuilds+installs the client, pairs, and tails the client console
# to {{sim_console_log}}. Blocks. Use agent-feed-sim-pair for the non-blocking
# variant when driving with Maestro (just ui-flow agent-feed-smoke).
agent-feed-sim:
    just build-agent-sidecar
    just build-agent-webview
    just host-run
    just client-sim-reinstall
    just dom-bridge-reinstall stable
    just sim-console-run

# Non-blocking twin of agent-feed-sim: builds the real artifacts, rebuilds and
# reinstalls host + client, then does a non-blocking paired launch (pair-sim)
# so the app stays open for `just ui-flow <flow>` (e.g. agent-feed-smoke) to
# drive it and capture screenshots.
agent-feed-sim-pair:
    just build-agent-sidecar
    just build-agent-webview
    just host-run
    just client-sim-reinstall
    just dom-bridge-reinstall stable
    just pair-sim

# Dev-variant twins of agent-feed-sim / agent-feed-sim-pair: a complete dev-stack
# simulator bring-up (dev host + dev client on the dev sim {{ios_sim_udid_dev}},
# separate ports and derived-data), with the Chrome DOM mirror enabled on both
# sides by default (ADR-0038). This is the sim analog of fresh-install-dev /
# fresh-diagnostic-run-dev on the physical device; it leaves the stable stack
# untouched so both can run side by side. agent-feed-sim-dev BLOCKS with an
# attached console (watch DOM-mirror probes + traces live); agent-feed-sim-pair-dev
# RETURNS so you can drive the app with `just ui-flow <flow>`.
agent-feed-sim-dev:
    just build-agent-sidecar
    just build-agent-webview
    just host-run dev
    just client-sim-reinstall dev
    just dom-bridge-reinstall dev
    just sim-console-run dev

agent-feed-sim-pair-dev:
    just build-agent-sidecar
    just build-agent-webview
    just host-run dev
    just client-sim-reinstall dev
    just dom-bridge-reinstall dev
    just pair-sim dev

# Drive the iPhone simulator with a Maestro flow. Maestro is the standard
# tool for declarative iOS UI automation (Playwright-equivalent for mobile);
# prefer adding a flow under client/maestro/ over hacking the app with
# env-gated triggers when you need to inspect a transient UI state.
#
# Screenshots emitted by `takeScreenshot:` land in the CWD where maestro
# runs, so we cd into client/maestro/screenshots first to keep them
# corralled and gitignorable. Pass the flow as the positional arg, eg.
# `just ui-flow keyboard-up`.
#
# Requires brew-installed openjdk on PATH for JAVA_HOME.
ui-flow flow:
    mkdir -p client/maestro/screenshots
    cd client/maestro/screenshots && \
        JAVA_HOME="$(brew --prefix openjdk)/libexec/openjdk.jdk/Contents/Home" \
        maestro --udid {{ios_sim_udid}} test ../{{flow}}.yaml

# Print the client build number used by TestFlight recipes. Defaults to a UTC
# timestamp so repeated uploads do not collide in App Store Connect.
client-build-number:
    @tools/testflight-upload.sh build-number

# Build a signed iOS Release archive for TestFlight export/upload.
# variant: "stable" (default) or "dev" (the experimental record, bundle id
# {{client_dev_bundle_id}}, separate archive path; identity overridden inline).
client-archive-release variant="stable":
    #!/usr/bin/env bash
    # Override per upload: AGENTDESK_CLIENT_VERSION=1.0 AGENTDESK_CLIENT_BUILD=20260621173045 just client-archive-release
    set -euo pipefail
    BUILD_NUMBER="$(tools/testflight-upload.sh build-number)"
    GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
    if [ "{{variant}}" = "dev" ]; then
        ARCHIVE='{{client_dev_archive_path}}'; DD='{{dev_derived_data}}'
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{client_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev BUNDLE_DISPLAY_NAME='AgentDesk Dev')
    else
        ARCHIVE='{{client_archive_path}}'; DD='{{derived_data}}'
        EXTRA=()
    fi
    mkdir -p "$(dirname "$ARCHIVE")"
    echo "Archiving AgentDeskClient ({{variant}}) {{client_marketing_version}} ($BUILD_NUMBER) commit $GIT_SHA"
    xcodebuild -project client/AgentDeskClient.xcodeproj \
        -scheme AgentDeskClient \
        -derivedDataPath "$DD" \
        -configuration Release \
        -destination 'generic/platform=iOS' \
        -archivePath "$ARCHIVE" \
        DEVELOPMENT_TEAM='{{apple_team_id}}' \
        MARKETING_VERSION='{{client_marketing_version}}' \
        CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
        AGENTDESK_GIT_SHA="$GIT_SHA" \
        ${EXTRA[@]+"${EXTRA[@]}"} \
        -allowProvisioningUpdates \
        clean archive

# Export the signed Release archive to an App Store Connect IPA.
client-export-ipa variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then ARCHIVE='{{client_dev_archive_path}}'; EXPORT='{{client_dev_export_path}}'; IPA='{{client_dev_ipa_path}}'; else ARCHIVE='{{client_archive_path}}'; EXPORT='{{client_export_path}}'; IPA='{{client_ipa_path}}'; fi
    test -d "$ARCHIVE" || { echo "archive missing: $ARCHIVE"; exit 1; }
    rm -rf "$EXPORT"
    mkdir -p "$EXPORT"
    xcodebuild -exportArchive \
        -archivePath "$ARCHIVE" \
        -exportPath "$EXPORT" \
        -exportOptionsPlist tools/testflight-export-options.plist \
        -allowProvisioningUpdates
    test -f "$IPA" || { echo "IPA missing: $IPA"; find "$EXPORT" -maxdepth 2 -type f -print; exit 1; }
    echo "IPA: $IPA"

# Upload a signed IPA to App Store Connect for internal TestFlight processing.
# Requires AGENTDESK_ASC_KEY_ID, AGENTDESK_ASC_ISSUER_ID, and
# AGENTDESK_ASC_API_KEY_PATH in .env or the shell environment. The dev variant
# routes to its own App Store Connect record by bundle id (the record is HITL).
testflight-upload variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    tools/testflight-upload.sh require-upload-env
    if [ "{{variant}}" = "dev" ]; then IPA='{{client_dev_ipa_path}}'; else IPA='{{client_ipa_path}}'; fi
    just client-archive-release {{variant}}
    just client-export-ipa {{variant}}
    tools/testflight-upload.sh upload "$IPA"
    echo "Upload submitted. App Store Connect may still need processing time before the build appears in TestFlight."

# Build/export locally without uploading, useful for signing or export checks.
testflight-build:
    just client-archive-release
    just client-export-ipa

# Open the generated archive in Xcode so Organizer can distribute it manually.
client-open-archive:
    just client-archive-release
    open -a Xcode '{{client_archive_path}}'

# Open App Store Connect after an upload.
testflight-open:
    open 'https://appstoreconnect.apple.com/apps'

# Short archive recipe kept as the local archive action.
client-archive:
    just client-archive-release
