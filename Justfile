ios_test_destination := env_var_or_default("AGENTDESK_IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPhone 17,OS=latest")

check:
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost build test
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -sdk iphonesimulator -destination '{{ios_test_destination}}' build test

dev:
    open host/AgentDeskHost.xcodeproj
    open client/AgentDeskClient.xcodeproj
