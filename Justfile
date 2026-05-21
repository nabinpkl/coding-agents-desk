ios_test_destination := env_var_or_default("AGENTDESK_IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPhone 17,OS=latest")
ios_device := env_var_or_default("AGENTDESK_IOS_DEVICE", "93DF5649-FC7B-5460-A6B4-74D2C1CEAB07")
last_pair_url_path := env_var_or_default("HOME", "") + "/Library/Application Support/AgentDesk/.last-pair-url"
host_app := env_var_or_default("HOME", "") + "/Library/Developer/Xcode/DerivedData/AgentDeskHost-gmjyarrzlrjgctfcursfnnulwzfg/Build/Products/Debug/AgentDeskHost.app"
client_app := env_var_or_default("HOME", "") + "/Library/Developer/Xcode/DerivedData/AgentDeskClient-asnebogtvhgngpdusosdqtlwsphl/Build/Products/Debug-iphoneos/AgentDeskClient.app"

check:
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost build test
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -sdk iphonesimulator -destination '{{ios_test_destination}}' build test

dev:
    open host/AgentDeskHost.xcodeproj
    open client/AgentDeskClient.xcodeproj

# Build host Debug and (re)launch it as a single instance.
host-run:
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug build >/dev/null
    -kill $(pgrep -f AgentDeskHost) 2>/dev/null || true
    sleep 1
    open "{{host_app}}"
    sleep 1
    pgrep -lf AgentDeskHost

# Build client Debug for the iPhone and install (does not launch).
client-install:
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -destination 'platform=iOS,id={{ios_device}}' build >/dev/null
    xcrun devicectl device install app --device {{ios_device}} "{{client_app}}"

# Trigger pairing without scanning the QR. Sends SIGUSR1 to the running host
# (which mints a fresh URL and writes it to {{last_pair_url_path}}), then
# launches the iPhone client with the URL as a CommandLine argument so
# SceneDelegate routes it via handleIncomingPairingURL. The user just runs
# this; no menubar click, no camera, no manual paste.
pair-iphone:
    @test -n "$(pgrep -f AgentDeskHost)" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "{{last_pair_url_path}}"
    kill -USR1 $(pgrep -f AgentDeskHost)
    @i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    @test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    @echo "URL: $(cat '{{last_pair_url_path}}')"
    xcrun devicectl device process launch --device {{ios_device}} --terminate-existing com.example.agentdesk.AgentDeskClient "$(cat '{{last_pair_url_path}}')"
