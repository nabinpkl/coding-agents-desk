# Load the gitignored .env so recipes (notably host-run) can forward
# config such as AGENTDESK_TRANSCRIBE_URL into the launched app without
# the value being hardcoded here. .env.example documents every knob.
set dotenv-load := true

ios_test_destination := env_var_or_default("AGENTDESK_IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPhone 17,OS=latest")
ios_device := env_var_or_default("AGENTDESK_IOS_DEVICE", "93DF5649-FC7B-5460-A6B4-74D2C1CEAB07")
# UDID of the iPhone simulator used for Maestro UI flows. Override via env.
ios_sim_udid := env_var_or_default("AGENTDESK_IOS_SIM_UDID", "00000000-0000-4000-8000-000000000022")
last_pair_url_path := env_var_or_default("HOME", "") + "/Library/Application Support/AgentDesk/.last-pair-url"
host_app := env_var_or_default("HOME", "") + "/Library/Developer/Xcode/DerivedData/AgentDeskHost-gmjyarrzlrjgctfcursfnnulwzfg/Build/Products/Debug/AgentDeskHost.app"
client_app := env_var_or_default("HOME", "") + "/Library/Developer/Xcode/DerivedData/AgentDeskClient-asnebogtvhgngpdusosdqtlwsphl/Build/Products/Debug-iphoneos/AgentDeskClient.app"
client_sim_app := env_var_or_default("HOME", "") + "/Library/Developer/Xcode/DerivedData/AgentDeskClient-asnebogtvhgngpdusosdqtlwsphl/Build/Products/Debug-iphonesimulator/AgentDeskClient.app"

check:
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost build test
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -sdk iphonesimulator -destination '{{ios_test_destination}}' build test

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

# Build host Debug and (re)launch it via LaunchServices so macOS TCC
# attributes Screen Recording (and any other privacy prompt) to
# AgentDeskHost itself, not to the terminal/IDE that runs this recipe.
# Launching the binary directly from a shell makes TCC walk the spawn
# chain to the responsible GUI ancestor (VS Code, Terminal.app, etc.)
# and prompts for THAT app, which is the bug surfaced during R8.6.5
# bring-up.
#
# AGENTDESK_AUTO_APPROVE is pushed through `launchctl setenv` so the
# launchd-managed GUI launch inherits it. The unsetenv after launch
# keeps the variable from polluting other apps started later in the
# same login session.
#
# AGENTDESK_TRANSCRIBE_URL (and _MODEL) come from .env via dotenv-load
# and are forwarded the same way so dictation has its now-required
# endpoint without a hand-run `launchctl setenv` each launch. The app
# captures its environment at launch, so the post-open unsetenv does not
# disturb the running host. Each var is only unset if we set it, so a
# value the user pinned into launchd out-of-band survives.
host-run:
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug build >/dev/null
    -kill $(pgrep -f AgentDeskHost) 2>/dev/null || true
    sleep 1
    launchctl setenv AGENTDESK_AUTO_APPROVE 1
    launchctl setenv AGENTDESK_DEV_PERMISSIVE_KEYSTORE 1
    [ -n "${AGENTDESK_TRANSCRIBE_URL:-}" ] && launchctl setenv AGENTDESK_TRANSCRIBE_URL "${AGENTDESK_TRANSCRIBE_URL}" || true
    [ -n "${AGENTDESK_TRANSCRIBE_MODEL:-}" ] && launchctl setenv AGENTDESK_TRANSCRIBE_MODEL "${AGENTDESK_TRANSCRIBE_MODEL}" || true
    [ -n "${AGENTDESK_SPACE_AGENT_LAYOUT:-}" ] && launchctl setenv AGENTDESK_SPACE_AGENT_LAYOUT "${AGENTDESK_SPACE_AGENT_LAYOUT}" || true
    open "{{host_app}}"
    sleep 2
    launchctl unsetenv AGENTDESK_AUTO_APPROVE
    launchctl unsetenv AGENTDESK_DEV_PERMISSIVE_KEYSTORE
    [ -n "${AGENTDESK_TRANSCRIBE_URL:-}" ] && launchctl unsetenv AGENTDESK_TRANSCRIBE_URL || true
    [ -n "${AGENTDESK_TRANSCRIBE_MODEL:-}" ] && launchctl unsetenv AGENTDESK_TRANSCRIBE_MODEL || true
    [ -n "${AGENTDESK_SPACE_AGENT_LAYOUT:-}" ] && launchctl unsetenv AGENTDESK_SPACE_AGENT_LAYOUT || true
    pgrep -lf AgentDeskHost

# Build client Debug for the iPhone and install (does not launch).
client-install:
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -destination 'platform=iOS,id={{ios_device}}' build >/dev/null
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

fresh-install:
    just host-run
    just client-reinstall
    just pair-iphone

# Build client Debug for the iPhone simulator and install (does not launch).
# Mirrors `client-install` but targets the simulator instead of the
# physical device.
client-sim-install:
    xcrun simctl bootstatus {{ios_sim_udid}} -b >/dev/null
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,id={{ios_sim_udid}}' build >/dev/null
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