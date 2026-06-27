# Load the gitignored .env so recipes (notably host-run) can forward
# config such as AGENTDESK_TRANSCRIBE_URL into the launched app without
# the value being hardcoded here. .env.example documents every knob.
set dotenv-load := true

ios_test_destination := env_var_or_default("AGENTDESK_IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPhone 17,OS=latest")
ios_device := env_var_or_default("AGENTDESK_IOS_DEVICE", "93DF5649-FC7B-5460-A6B4-74D2C1CEAB07")
# UDID of the iPhone simulator used for Maestro UI flows. Override via env.
ios_sim_udid := env_var_or_default("AGENTDESK_IOS_SIM_UDID", "00000000-0000-4000-8000-000000000022")
iphone_log_archive := env_var_or_default("AGENTDESK_IPHONE_LOG_ARCHIVE", "/tmp/agentdesk-client.logarchive")
iphone_log_minutes := env_var_or_default("AGENTDESK_IPHONE_LOG_MINUTES", "5")
iphone_console_log := env_var_or_default("AGENTDESK_IPHONE_CONSOLE_LOG", "/tmp/agentdesk-client-console.log")
sim_console_log := env_var_or_default("AGENTDESK_SIM_CONSOLE_LOG", "/tmp/agentdesk-sim-console.log")
iphone_log_device_udid := env_var_or_default("AGENTDESK_IOS_DEVICE_UDID", "")
last_pair_url_path := env_var_or_default("HOME", "") + "/Library/Application Support/AgentDesk/.last-pair-url"
derived_data := env_var_or_default("AGENTDESK_DERIVED_DATA_PATH", justfile_directory() + "/.build/DerivedData")
host_app := derived_data + "/Build/Products/Debug/AgentDeskHost.app"
client_app := derived_data + "/Build/Products/Debug-iphoneos/AgentDeskClient.app"
client_sim_app := derived_data + "/Build/Products/Debug-iphonesimulator/AgentDeskClient.app"
client_archive_path := env_var_or_default("AGENTDESK_CLIENT_ARCHIVE_PATH", justfile_directory() + "/.build/testflight/AgentDeskClient.xcarchive")
client_export_path := env_var_or_default("AGENTDESK_CLIENT_EXPORT_PATH", justfile_directory() + "/.build/testflight/export")
client_ipa_path := env_var_or_default("AGENTDESK_CLIENT_IPA_PATH", client_export_path + "/AgentDeskClient.ipa")
# Marketing versions (CFBundleShortVersionString), semver, bumped PER RELEASE not
# per build: MAJOR = incompatible change, MINOR = new feature, PATCH = bug fix.
# Host and client are versioned INDEPENDENTLY (separate release cadences); their
# compatibility is the wire protocol version (Config.protocolVersion), not these
# numbers. The build number is independent (git commit count) and the short git
# sha is embedded, so a build reads as "v1.3.0 (382) c5b4fb2". See AGENTS.md
# "Versioning". History: 1.1.0 = Mac-initiated pairing (ADR-0019); 1.2.0 = live
# tailnet device discovery (R55); 1.3.0 = independent host/client versions +
# protocol-version negotiation (ADR-0020, R56).
host_marketing_version := env_var_or_default("AGENTDESK_HOST_VERSION", "1.3.1")
client_marketing_version := env_var_or_default("AGENTDESK_CLIENT_VERSION", "1.3.1")
apple_team_id := env_var_or_default("AGENTDESK_APPLE_TEAM_ID", "TEAMID0000")

check:
    sh tools/media-architecture-guard.sh
    sh tools/launch-env-tests.sh
    sh tools/hybrid-graphics-diagnostics-summary-tests.sh
    sh tools/testflight-upload-tests.sh
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -derivedDataPath '{{derived_data}}' build test
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -derivedDataPath '{{derived_data}}' -sdk iphonesimulator -destination '{{ios_test_destination}}' build test

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
iphone-log-collect:
    rm -rf "{{iphone_log_archive}}"
    @if [ -n "{{iphone_log_device_udid}}" ]; then \
        sudo /usr/bin/log collect --device-udid "{{iphone_log_device_udid}}" --last "{{iphone_log_minutes}}m" --predicate 'subsystem == "com.example.agentdesk.AgentDeskClient"' --output "{{iphone_log_archive}}"; \
    else \
        sudo /usr/bin/log collect --device --last "{{iphone_log_minutes}}m" --predicate 'subsystem == "com.example.agentdesk.AgentDeskClient"' --output "{{iphone_log_archive}}"; \
    fi
    /usr/bin/log show --style compact --info --debug --predicate 'subsystem == "com.example.agentdesk.AgentDeskClient"' "{{iphone_log_archive}}"

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
# with `just fresh-install`. The scroll-hybrid worktree also documents
# AGENTDESK_GRAPHICS_PORT and AGENTDESK_HYBRID_* in .env.example; those
# knobs become active when the graphics stream and cadence wiring land.
host-run:
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath '{{derived_data}}' MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build >/dev/null
    -kill $(pgrep -f AgentDeskHost) 2>/dev/null || true
    sleep 1
    AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 tools/launch-env.sh set
    open "{{host_app}}"
    sleep 2
    AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 tools/launch-env.sh unset
    pgrep -lf AgentDeskHost

# Build client Debug for the iPhone and install (does not launch).
client-install:
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath '{{derived_data}}' -destination 'platform=iOS,id={{ios_device}}' build >/dev/null
    xcrun devicectl device install app --device {{ios_device}} "{{client_app}}"

# Uninstall + clean install. iOS caches device-family and other bundle
# metadata for an installed bundle id; rebuilding alone does not flush
# that cache. Use this after changes to TARGETED_DEVICE_FAMILY,
# UIRequires*, or anything else iOS reads at install time.
client-reinstall:
    -xcrun devicectl device uninstall app --device {{ios_device}} com.example.agentdesk.AgentDeskClient 2>/dev/null || true
    just client-install

# Trigger pairing without scanning the QR. Sends SIGUSR1 to the running host
# (which mints a fresh URL and writes it to {{last_pair_url_path}}), then
# launches the iPhone client with the URL as a CommandLine argument so
# SceneDelegate routes it via handleIncomingPairingURL. The user just runs
# this; no menubar click, no camera, no manual paste.
pair-iphone:
    @test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "{{last_pair_url_path}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    @i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    @test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    @echo "URL: $(cat '{{last_pair_url_path}}')"
    URL="$(cat '{{last_pair_url_path}}')"; xcrun devicectl device process launch --device {{ios_device}} --terminate-existing --environment-variables "{\"AGENTDESK_LAUNCH_URL\":\"$URL\"}" com.example.agentdesk.AgentDeskClient "$URL"

# Pair-launch the physical iPhone client with stdio attached. This blocks
# until the app exits, and mirrors stdout/stderr to the configured log file.
# Owned media stderr tracing is enabled so packet-repair diagnostics have a
# live path separate from iOS unified logging.
iphone-console-run:
    @test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "{{last_pair_url_path}}" "{{iphone_console_log}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    @i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    @test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    @echo "URL: $(cat '{{last_pair_url_path}}')"
    bash -o pipefail -c 'URL="$(cat "{{last_pair_url_path}}")"; xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing --environment-variables "{\"AGENTDESK_LAUNCH_URL\":\"$URL\",\"AGENTDESK_OWNED_MEDIA_STDERR_TRACE\":\"1\"}" com.example.agentdesk.AgentDeskClient "$URL" 2>&1 | tee "{{iphone_console_log}}"'

fresh-install:
    just host-run
    just client-reinstall
    just pair-iphone

# Rebuild and relaunch the host, reinstall the physical iPhone app, then
# launch the client with stdout/stderr attached for owned-media diagnostics.
fresh-consoled-run:
    just host-run
    just client-reinstall
    just iphone-console-run

# Branch-local scroll-first hybrid retained-graphics run. This keeps the
# physical iPhone attached console path and preserves
# /tmp/agentdesk-client-console.log for media and compositor diagnostics.
# It delegates to the current consoled run until the reliable graphics
# stream and retained compositor behavior land.
fresh-hybrid-consoled-run:
    just fresh-consoled-run

# Build client Debug for the iPhone simulator and install (does not launch).
# Mirrors `client-install` but targets the simulator instead of the
# physical device.
client-sim-install:
    xcrun simctl bootstatus {{ios_sim_udid}} -b >/dev/null
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath '{{derived_data}}' -sdk iphonesimulator -destination 'platform=iOS Simulator,id={{ios_sim_udid}}' build >/dev/null
    xcrun simctl install {{ios_sim_udid}} "{{client_sim_app}}"

# Uninstall + clean install on the simulator. Same reasoning as
# `client-reinstall`: install-time bundle metadata (UILaunchScreen,
# TARGETED_DEVICE_FAMILY) is cached by the simulator and not flushed
# by a plain rebuild.
client-sim-reinstall:
    -xcrun simctl uninstall {{ios_sim_udid}} com.example.agentdesk.AgentDeskClient 2>/dev/null || true
    just client-sim-install

# Simulator equivalent of `pair-iphone`. Asks the running host to mint
# a fresh pair URL (SIGUSR1 -> writes to {{last_pair_url_path}}), then
# launches the app with two env vars:
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
pair-sim:
    @test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "{{last_pair_url_path}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    @i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    @test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    @echo "URL: $(cat '{{last_pair_url_path}}')"
    xcrun simctl bootstatus {{ios_sim_udid}} -b >/dev/null
    SIMCTL_CHILD_AGENTDESK_LAUNCH_URL="$(cat '{{last_pair_url_path}}')" \
        SIMCTL_CHILD_AGENTDESK_DEV_HOST_OVERRIDE=localhost \
        xcrun simctl launch --terminate-running-process {{ios_sim_udid}} com.example.agentdesk.AgentDeskClient

# Pair-launch the simulator client with stdout/stderr attached. This is
# the simulator mirror of `iphone-console-run`: it blocks until the app exits
# and tees owned-media stderr traces into {{sim_console_log}}. Maestro flows
# used with this recipe must not include `launchApp`, because relaunching the
# app drops the explicit pairing URL and simulator-only localhost override.
sim-console-run:
    @test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "{{last_pair_url_path}}" "{{sim_console_log}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    @i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    @test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    @echo "URL: $(cat '{{last_pair_url_path}}')"
    xcrun simctl bootstatus {{ios_sim_udid}} -b >/dev/null
    bash -o pipefail -c 'URL="$(cat "{{last_pair_url_path}}")"; SIMCTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" SIMCTL_CHILD_AGENTDESK_DEV_HOST_OVERRIDE=localhost SIMCTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE=1 xcrun simctl launch --console --terminate-running-process {{ios_sim_udid}} com.example.agentdesk.AgentDeskClient "$URL" 2>&1 | tee "{{sim_console_log}}"'

# Rebuild and relaunch the Mac host, uninstall and reinstall the iOS
# app on the simulator, then pair and open it. Use after changes that
# affect either side's install-time metadata, or when you want a
# known-clean simulator starting point for a Maestro flow run.
# Uninstall wipes UserDefaults so pairing always has to be re-done;
# pair-sim handles that and leaves the app open on the trackpad screen.
sim-fresh-install:
    just host-run
    just client-sim-reinstall
    just pair-sim

# Rebuild and relaunch the Mac host, uninstall/reinstall the simulator app,
# then pair-launch with stdout/stderr attached. This is the default simulator
# feel-test path when an agent needs to inspect client owned-media logs.
fresh-sim-consoled-run:
    just host-run
    just client-sim-reinstall
    just sim-console-run

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
client-archive-release:
    # Override per upload: AGENTDESK_CLIENT_VERSION=1.0 AGENTDESK_CLIENT_BUILD=20260621173045 just client-archive-release
    mkdir -p "$(dirname '{{client_archive_path}}')"
    @BUILD_NUMBER="$(tools/testflight-upload.sh build-number)"; \
        GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"; \
        echo "Archiving AgentDeskClient {{client_marketing_version}} ($BUILD_NUMBER) commit $GIT_SHA"; \
        xcodebuild -project client/AgentDeskClient.xcodeproj \
            -scheme AgentDeskClient \
            -derivedDataPath '{{derived_data}}' \
            -configuration Release \
            -destination 'generic/platform=iOS' \
            -archivePath '{{client_archive_path}}' \
            DEVELOPMENT_TEAM='{{apple_team_id}}' \
            MARKETING_VERSION='{{client_marketing_version}}' \
            CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
            AGENTDESK_GIT_SHA="$GIT_SHA" \
            -allowProvisioningUpdates \
            clean archive

# Export the signed Release archive to an App Store Connect IPA.
client-export-ipa:
    @test -d '{{client_archive_path}}' || { echo "archive missing: {{client_archive_path}}"; exit 1; }
    rm -rf '{{client_export_path}}'
    mkdir -p '{{client_export_path}}'
    xcodebuild -exportArchive \
        -archivePath '{{client_archive_path}}' \
        -exportPath '{{client_export_path}}' \
        -exportOptionsPlist tools/testflight-export-options.plist \
        -allowProvisioningUpdates
    @test -f '{{client_ipa_path}}' || { echo "IPA missing: {{client_ipa_path}}"; find '{{client_export_path}}' -maxdepth 2 -type f -print; exit 1; }
    @echo "IPA: {{client_ipa_path}}"

# Upload a signed IPA to App Store Connect for internal TestFlight processing.
# Requires AGENTDESK_ASC_KEY_ID, AGENTDESK_ASC_ISSUER_ID, and
# AGENTDESK_ASC_API_KEY_PATH in .env or the shell environment.
testflight-upload:
    tools/testflight-upload.sh require-upload-env
    just client-archive-release
    just client-export-ipa
    tools/testflight-upload.sh upload '{{client_ipa_path}}'
    @echo "Upload submitted. App Store Connect may still need processing time before the build appears in TestFlight."

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
