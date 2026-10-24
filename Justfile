# Load the gitignored .env so launch recipes can forward their documented
# host configuration without values being hardcoded here.
set dotenv-load := true

# A simulator that this Mac actually has. Xcode updates retire simulator models, and when the
# named one is gone `sim-test` fails with exit 70 and "Unable to find a device matching the
# provided destination specifier" BEFORE running a single test -- which reads as a broken gate
# rather than a stale name. If that happens, `xcrun xctrace list devices` shows what exists and
# AGENTDESK_IOS_TEST_DESTINATION overrides this without editing the file.
ios_test_destination := env_var_or_default("AGENTDESK_IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest")
# Use the hardware UDID: Xcode requires it as the destination id, and
# devicectl accepts the same value for install, launch, and diagnostics.
ios_device := env_var_or_default("AGENTDESK_IOS_DEVICE", "00000000-0000000000000000")
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
# The host's own stdout/stderr on an ordinary launch. A Swift trap prints its message here and
# nowhere else: it never reaches os_log, and a crash that produces no .ips leaves no other trace.
# The previous launch rolls to `<file>.prev`, because relaunching after a crash is exactly when
# that output is wanted and truncating in place is how you lose it.
host_stdio := env_var_or_default("AGENTDESK_HOST_STDIO", "/tmp/agentdesk-host-stdio.log")
# How much of a launch's output to carry into `.prev`. A trap prints at the end, so the tail is
# the part worth keeping, and capping it means a run that starts chattering to stderr cannot turn
# crash evidence into an unbounded file. The live log is uncapped: it measured zero bytes across a
# normal host lifetime, so a rotator reading a FIFO would be machinery guarding nothing, and a
# reader that died would block the host on a full pipe.
host_stdio_keep_bytes := env_var_or_default("AGENTDESK_HOST_STDIO_KEEP_BYTES", "4194304")
motion_client_diagnostics := env_var_or_default("AGENTDESK_MOTION_CLIENT_DIAGNOSTICS", "/tmp/agentdesk-motion-client-diagnostics")
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
host_pty_manager_socket_path := host_support_dir + "/pty-manager.sock"
host_dev_pty_manager_socket_path := host_dev_support_dir + "/pty-manager.sock"
client_debug_request_path := host_support_dir + "/.client-debug-request.json"
client_debug_result_path := host_support_dir + "/.client-debug-result.json"
host_dev_client_debug_request_path := host_dev_support_dir + "/.client-debug-request.json"
host_dev_client_debug_result_path := host_dev_support_dir + "/.client-debug-result.json"
derived_data := env_var_or_default("AGENTDESK_DERIVED_DATA_PATH", justfile_directory() + "/.build/DerivedData")
host_build_app := derived_data + "/Build/Products/Debug/AgentDeskHost.app"
client_app := derived_data + "/Build/Products/Debug-iphoneos/AgentDeskClient.app"
client_sim_app := derived_data + "/Build/Products/Debug-iphonesimulator/AgentDeskClient.app"
# Release-configuration product paths, used by the Release feel-test composites
# (fresh-install / sim-fresh-install). xcodebuild writes Release products into a
# separate Products/Release* dir, so these coexist with the Debug builds above.
host_build_app_release := derived_data + "/Build/Products/Release/AgentDeskHost.app"
client_app_release := derived_data + "/Build/Products/Release-iphoneos/AgentDeskClient.app"
client_sim_app_release := derived_data + "/Build/Products/Release-iphonesimulator/AgentDeskClient.app"
# Two coexisting HOST installs mirroring the client: the stable daily-driver and
# an experimental "dev" host under test. They differ by bundle id (com.example.agentdesk.
# AgentDeskHost / .dev), so each self-namespaces its logs, keychain, Application
# Support state, launchd label, and tier-derived ports (Config.tier) and can run
# CONCURRENTLY. The dev host builds into a SEPARATE derived-data dir: both share
# PRODUCT_NAME (AgentDeskHost.app) so they would otherwise clobber build output.
# The installed path is how the kill step targets one variant without killing the
# other (a bare `pkill -f AgentDeskHost` would kill both). Override ids via env.
host_bundle_id := env_var_or_default("AGENTDESK_HOST_BUNDLE_ID", "com.example.agentdesk.AgentDeskHost")
host_dev_bundle_id := env_var_or_default("AGENTDESK_HOST_DEV_BUNDLE_ID", "com.example.agentdesk.AgentDeskHost.dev")
host_dev_derived_data := derived_data + "-host-dev"
host_dev_build_app := host_dev_derived_data + "/Build/Products/Debug/AgentDeskHost.app"
host_dev_build_app_release := host_dev_derived_data + "/Build/Products/Release/AgentDeskHost.app"
# ADR-0113: compilation products are never live runtime paths. One shared resolver
# owns these defaults for recipes and the TypeScript sidecar. Each host variant
# has one installed app location across Debug/Release builds and source checkouts.
runtime_root := shell('node tools/runtime-paths.mjs root')
host_app := shell('node tools/runtime-paths.mjs host-app "$1"', host_bundle_id)
host_dev_app := shell('node tools/runtime-paths.mjs host-app "$1"', host_dev_bundle_id)
grid_encoder := shell('node tools/runtime-paths.mjs grid-encoder')
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
# Isolated derived-data path for TestFlight archiving. The archive runs `clean archive`, which wipes
# its derived data's Build tree; a dedicated dir keeps archive cleanup from invalidating
# concurrent builds. Running hosts are independent installed copies under `runtime_root`.
# The client test gate builds into its own tree so it never shares a build database with a
# device or host build. Xcode takes an exclusive lock on build.db, so a `sim-test` running
# beside a `client-install` used to fail one of the two with "build.db is locked" -- and the
# test gate is exactly the thing you want to run WHILE a device build is going.
sim_test_derived_data := env_var_or_default("AGENTDESK_SIM_TEST_DERIVED_DATA", justfile_directory() + "/.build/DerivedData-sim-test")
client_archive_derived_data := env_var_or_default("AGENTDESK_CLIENT_ARCHIVE_DERIVED_DATA", justfile_directory() + "/.build/DerivedData-archive")
client_dev_archive_derived_data := justfile_directory() + "/.build/DerivedData-archive-dev"
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
host_marketing_version := env_var_or_default("AGENTDESK_HOST_VERSION", "1.7.0")
client_marketing_version := env_var_or_default("AGENTDESK_CLIENT_VERSION", "1.14.0")
apple_team_id := env_var_or_default("AGENTDESK_APPLE_TEAM_ID", "TEAMID0000")
# AgentDesk-owned source for transcript discovery, parsing, indexing, and feed
# HTTP/SSE delivery.
agent_feed_sidecar_dir := justfile_directory() + "/agent-feed/sidecar"
# AgentDesk-owned Vite source for the shared AgentPanel webview.
agent_panel_web_dir := justfile_directory() + "/packages/AgentPanel/Web"
# The env var that points the panel's webview at a dev server instead of its bundled build.
# Mirrors AgentPanelWebViewController.developmentOriginVariable; a second spelling would be a
# build that looks live and is not.
agent_panel_origin_var := "AGENTDESK_AGENT_PANEL_ORIGIN"
# Where the panel's Vite dev server listens, and where its output goes when a host launch starts
# it rather than a human. One port for both host variants on purpose: the panel is the same code
# either way, and it reaches its own tier's sidecar through that host's relay, not through Vite.
agent_panel_dev_port := env_var_or_default("AGENTDESK_AGENT_PANEL_DEV_PORT", "5173")
agent_panel_dev_log := env_var_or_default("AGENTDESK_AGENT_PANEL_DEV_LOG", "/tmp/agentdesk-agent-panel-dev.log")
# Where the login launch writes what it did. A file rather than os_log, because this runs at
# login and the question it answers is always asked afterwards -- and `log show` returns nothing on
# this machine, for any process, so os_log here would be a record that cannot be read back.
dev_login_log := env_var_or_default("AGENTDESK_DEV_LOGIN_LOG", "/tmp/agentdesk-dev-login.log")
panel_dev_login_log := env_var_or_default("AGENTDESK_PANEL_DEV_LOGIN_LOG", "/tmp/agentdesk-panel-dev-login.log")
remote_sidecar_login_log := env_var_or_default("AGENTDESK_REMOTE_SIDECAR_LOGIN_LOG", "/tmp/agentdesk-remote-sidecar-login.log")
proxy_observer_relay_login_log := env_var_or_default("AGENTDESK_PROXY_OBSERVER_RELAY_LOGIN_LOG", "/tmp/agentdesk-proxy-observer-relay-login.log")
# The dev server's TLS material belongs to its durable runtime, outside the checkout.
# Deleting build caches must not erase the certificate/key of the running server.
agent_panel_dev_tls_dir := shell('node tools/runtime-paths.mjs panel-tls')
# Source directory for the AgentDesk-owned Rust PTY manager (moved in from the
# agent-workspace-ide donor under R34). Override only for out-of-tree experiments.
pty_manager_dir := env_var_or_default("AGENTDESK_PTY_MANAGER_DIR", justfile_directory() + "/terminal/pty-manager")
# The sidecar binary is placed alongside the Swift sources in AgentDeskHost/
# so Xcode picks it up as a bundled resource (it is wired into the project's
# Resources build phase). It is loaded at runtime via Config.agentFeedSidecarURL.
agent_feed_sidecar_out := justfile_directory() + "/host/AgentDeskHost/agent-feed-sidecar"
# The PTY manager binary is also placed alongside the host Swift sources so
# Xcode bundles it as a resource. It is loaded via Config.ptyManagerURL.
pty_manager_out := justfile_directory() + "/host/AgentDeskHost/pty-manager"
pty_vault_out := justfile_directory() + "/host/AgentDeskHost/pty-vault"
# The reusable AgentPanel package owns the authored Vite source and generated
# webview resource for both AppKit and UIKit consumers.
webview_out := justfile_directory() + "/packages/AgentPanel/Sources/AgentPanel/Resources/AgentPanelWebview"
# Source directory for the gesture/voice interaction web app (the shared webview
# authored once in gesture-agent, now vendored in-repo under ./gesture-agent).
# SSOT for its location; override via env for an out-of-tree checkout.
gesture_web_dir := env_var_or_default("AGENTDESK_GESTURE_WEB_DIR", justfile_directory() + "/gesture-agent/web")
# The reusable InteractionPanel package owns the generated gesture webview
# resource for both AppKit and UIKit consumers. The gesture-agent embed build
# output is published here before the consuming app build.
gesture_webview_out := justfile_directory() + "/packages/InteractionPanel/Sources/InteractionPanel/Resources/InteractionPanelWebview"
# Root of the in-repo gesture-agent tree (holds pyproject.toml + src for the
# voice sidecar). SSOT for its location; override via env for an out-of-tree checkout.
gesture_agent_dir := env_var_or_default("AGENTDESK_GESTURE_AGENT_DIR", justfile_directory() + "/gesture-agent")
# Staged voice-sidecar inputs inside the host app source tree (auto-picked up by
# the synchronized root group and copied into the app bundle). `uv` is the
# resolver/runner; `voice-src` is the read-only interaction-agent source the
# first-launch provisioner installs into the Application-Support venv; and the
# wheelhouse is the complete Python 3.13 dependency closure used offline.
voice_uv_out := justfile_directory() + "/host/AgentDeskHost/uv"
voice_src_out := justfile_directory() + "/host/AgentDeskHost/voice-src"
voice_wheelhouse_out := justfile_directory() + "/host/AgentDeskHost/voice-wheelhouse"
# The one tracked home for voice inputs that more than one target needs: the CMU
# dictionary and its license, and the CMUdict-to-model-phone mapping. The phone,
# the Python sidecar, and the offline calibration harness all derive their
# pronunciation view from these exact bytes, so they live in one place and are
# staged into each consumer rather than copied around the tree.
voice_assets_src := justfile_directory() + "/voice-assets"
# The Mac's copy of the voice models, which the host serves to the phone over the
# assets lane. Deliberately outside the repo and outside both app bundles: these
# are ~220 MB of read-only, hash-verified inputs, byte-identical across host
# variants, so bundling them charged every build for a resource copy and a code
# signature that bought nothing. Shared by the stable and dev hosts for the same
# reason. Config.voiceAssetRootURL resolves this exact path and honours the same
# override, so the two stay in step.
voice_assets_root := env_var_or_default("AGENTDESK_VOICE_ASSET_ROOT", env_var_or_default("HOME", "") + "/Library/Application Support/AgentDeskVoiceAssets")
# Where `just voice-phone-model` / `just voice-zipa-model` generate. A staging
# root, not a bundle: nothing ships from here, `voice-assets-publish` copies the
# runtime subset out of it.
voice_assets_staged := justfile_directory() + "/.build/voice-assets"
# Content-hash stamps that gate the bundled-artifact builds so host-run skips a
# rebuild when inputs are unchanged (see tools/source-hash.sh). Gitignored (.build).
stamps_dir := justfile_directory() + "/.build/stamps"
source_hash := justfile_directory() + "/tools/source-hash.sh"

# Ensure a minimal placeholder exists at the sidecar output path. The compiled
# binary is gitignored, so a fresh checkout needs a resource placeholder before
# Xcode resolves the synchronized source group.
ensure-agent-feed-sidecar-placeholder:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -e '{{agent_feed_sidecar_out}}' ]; then
        printf '#!/bin/sh\necho "agent-feed-sidecar placeholder - run: just build-agent-feed-sidecar" >&2\nexit 1\n' > '{{agent_feed_sidecar_out}}'
        chmod +x '{{agent_feed_sidecar_out}}'
    fi

# Ensure a minimal placeholder exists at the PTY manager output path. The real
# Rust binary is gitignored, so a fresh checkout has nothing there; without a
# placeholder, Xcode cannot discover the bundled resource path.
ensure-pty-runtime-placeholder:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -e '{{pty_manager_out}}' ]; then
        printf '#!/bin/sh\necho "pty-manager placeholder - run: just build-pty-runtime" >&2\nexit 1\n' > '{{pty_manager_out}}'
        chmod +x '{{pty_manager_out}}'
    fi
    if [ ! -e '{{pty_vault_out}}' ]; then
        printf '#!/bin/sh\necho "pty-vault placeholder - run: just build-pty-runtime" >&2\nexit 1\n' > '{{pty_vault_out}}'
        chmod +x '{{pty_vault_out}}'
    fi

# Build AgentDesk's transcript sidecar into the host app bundle source dir.
# The result is a self-contained executable that AgentFeedSidecarProcess spawns
# at runtime. It overwrites the gitignored placeholder in place.
#
# Distribution signing and notarization of this embedded binary is handled at
# DMG packaging time, not here. Local/dev builds run unsigned or with the
# local Developer ID applied during the normal Xcode codesign step.
build-agent-feed-sidecar:
    #!/usr/bin/env bash
    set -euo pipefail
    SIDECAR='{{agent_feed_sidecar_dir}}'
    ENTRY="$SIDECAR/src/server.ts"
    OUT='{{agent_feed_sidecar_out}}'
    STAMP='{{stamps_dir}}/agent-feed-sidecar'
    # These imported sources live outside the sidecar package but ship in its binary.
    HASH="$('{{source_hash}}' "$SIDECAR" "{{justfile_directory()}}/agent-feed/wire" "{{justfile_directory()}}/tools/runtime-paths.mjs")"
    if [ -f "$OUT" ] && [ "$HASH" = "$(cat "$STAMP" 2>/dev/null || true)" ]; then
        echo "build-agent-feed-sidecar: source unchanged, skipping"
        exit 0
    fi
    node '{{justfile_directory()}}/tools/build-system/ensure-js-dependencies.mjs' \
      agent-feed-sidecar "$SIDECAR" '{{justfile_directory()}}/.build/js-dependencies'
    TEMP_ROOT="${TMPDIR:-/tmp}"
    BUILD_DIR="$(mktemp -d "${TEMP_ROOT%/}/agentdesk-bun-build.XXXXXX")"
    cleanup() {
        rm -rf "$BUILD_DIR"
    }
    trap cleanup EXIT

    # Bun may create dot-prefixed compiler intermediates beside its working
    # directory. Run it from one disposable directory so the workspace and its
    # parent never surface those files in the Dock/file browser. The EXIT trap
    # removes intermediates after success, failure, or an interrupted build.
    # Leave Bun's own temp-cache selection alone; overriding BUN_TMPDIR makes
    # standalone compilation miss its normal fast path.
    cd "$BUILD_DIR"
    bun build --compile "$ENTRY" --outfile "$BUILD_DIR/agent-feed-sidecar"
    # Pi lazy-loads OAuth flows in ordinary Node/Bun execution, but a standalone
    # binary has no sibling JS files. Its supported bootstrap statically imports
    # them; this marker proves the OpenAI Codex implementation survived bundling.
    if ! /usr/bin/strings "$BUILD_DIR/agent-feed-sidecar" | rg -F \
        'OpenAI Codex OAuth is only available in Node.js environments' >/dev/null; then
      echo 'build-agent-feed-sidecar: compiled binary omitted Pi bundled OAuth flows' >&2
      exit 1
    fi
    chmod +x "$BUILD_DIR/agent-feed-sidecar"
    mv -f "$BUILD_DIR/agent-feed-sidecar" "$OUT"
    mkdir -p '{{stamps_dir}}'; printf '%s\n' "$HASH" > "$STAMP"

agent-feed-sidecar-check:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    SIDECAR='{{agent_feed_sidecar_dir}}'
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" agent-feed-sidecar "$SIDECAR" "$ROOT/.build/js-dependencies"
    cd "$SIDECAR"
    # A signal sent to this recipe (a timeout, a cancelled session) ends only this bash, and
    # `bun run test` runs `bun test` as a grandchild that carries on as an orphan. Measured
    # 2026-10-14: one such run kept going for 18 minutes after "terminated by signal 15" and held
    # 16GB of footprint (peak 23.5GB). So each step gets its own process group (`set -m`), and
    # leaving the recipe by any route kills whatever is still in the group last started.
    set -m
    STEP_PID=''
    reap_step() {
        [ -n "$STEP_PID" ] || return 0
        kill -0 -- "-$STEP_PID" 2>/dev/null || return 0
        kill -TERM -- "-$STEP_PID" 2>/dev/null || true
        sleep 2
        kill -KILL -- "-$STEP_PID" 2>/dev/null || true
    }
    trap reap_step EXIT
    trap 'exit 143' INT TERM HUP
    step() {
        "$@" &
        STEP_PID=$!
        wait "$STEP_PID"
    }
    step bun run typecheck
    step bun run test
    if rg -n --glob '!*.test.ts' \
        'watcher-cache|AGENT_FEED_STATE_DIR|projects/digest|ProjectDigest' src; then
        echo "agent-feed-sidecar-check: removed cache or digest contract returned" >&2
        exit 1
    fi

# Canary for the harness artifacts background-task detection reads (ADR-0099): the
# ~/.claude/sessions/<pid>.json registry, the <session>/tasks/<id>.output layout, and the
# terminal-marker text. A Claude Code release can move any of them, and when one moves the
# feature does not throw -- it reports nothing running, which looks exactly like a quiet
# machine. This asserts the contract instead of the weather, so drift fails loudly.
#
# NOT part of `just check`: it reads live processes, so its result depends on what is running.
agent-feed-background-tasks-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    SIDECAR='{{agent_feed_sidecar_dir}}'
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" agent-feed-sidecar "$SIDECAR" "$ROOT/.build/js-dependencies"
    cd "$SIDECAR"
    bun run scripts/background-tasks-smoke.ts

# Authenticated real-SDK gate for ADR-0091. This is manual because it spends one
# model turn. It proves Pi's existing auth/settings, built-in bash, two-viewer
# fan-out, control-token isolation, and persisted JSONL reopen through our adapter.
agent-feed-pi-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    SIDECAR='{{agent_feed_sidecar_dir}}'
    SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-feed-pi-smoke.XXXXXX")"
    cleanup() {
        rm -rf "$SMOKE_ROOT"
    }
    trap cleanup EXIT
    mkdir -p "$SMOKE_ROOT/project" "$SMOKE_ROOT/sessions"
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" agent-feed-sidecar "$SIDECAR" "$ROOT/.build/js-dependencies"
    cd "$SIDECAR"
    AGENT_FEED_PI_SESSIONS_DIR="$SMOKE_ROOT/sessions" \
        AGENT_FEED_SUMMARY_API_KEY="smoke-secret-that-must-not-reach-bash" \
        bun run scripts/pi-agent-smoke.ts "$SMOKE_ROOT/project"

# Build Agent Workspace IDE's Rust PTY manager into the host app bundle source
# dir. The host launches this binary and bridges shared web terminal clients into its
# Unix-socket multiplexer.
build-pty-runtime:
    #!/usr/bin/env bash
    set -euo pipefail
    PTY='{{pty_manager_dir}}'
    MANAGER_OUT='{{pty_manager_out}}'
    VAULT_OUT='{{pty_vault_out}}'
    cd "$PTY"
    cargo build --release --bin pty-manager --bin pty-vault
    cp "$PTY/target/release/pty-manager" "$MANAGER_OUT"
    cp "$PTY/target/release/pty-vault" "$VAULT_OUT"
    chmod +x "$MANAGER_OUT" "$VAULT_OUT"

# Build the real sidecar binary against isolated Claude/Codex fixtures. Verify
# one-shot project/session APIs and replacement snapshots from both SSE layers.
# This is for manual/coordinator verification; it is NOT part of `just check`.
agent-feed-sidecar-smoke: build-agent-feed-sidecar
    #!/usr/bin/env bash
    set -euo pipefail
    PORT=47998
    BINARY='{{agent_feed_sidecar_out}}'
    SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-feed-smoke.XXXXXX")"
    CLAUDE_ROOT="$SMOKE_ROOT/claude-projects"
    SMOKE_CODEX_HOME="$SMOKE_ROOT/codex"
    PI_SESSIONS_ROOT="$SMOKE_ROOT/pi-sessions"
    PROJECT_ONE="$SMOKE_ROOT/projects/one"
    PROJECT_TWO="$SMOKE_ROOT/projects/two"
    CLAUDE_SLUG="$CLAUDE_ROOT/discovery-only"
    ROLLOUT_ROOT="$SMOKE_CODEX_HOME/sessions/2026/07/24"
    LOG_FILE="$SMOKE_ROOT/sidecar.log"
    INVENTORY_STREAM="$SMOKE_ROOT/inventory.sse"
    SESSIONS_JSON="$SMOKE_ROOT/sessions.json"
    CLAUDE_ONE=11111111-1111-1111-1111-111111111111
    CODEX_ONE=22222222-2222-2222-2222-222222222222
    CLAUDE_TWO=33333333-3333-3333-3333-333333333333
    CLAUDE_THREE=44444444-4444-4444-4444-444444444444
    mkdir -p "$CLAUDE_SLUG" "$ROLLOUT_ROOT" "$PI_SESSIONS_ROOT" "$PROJECT_ONE" "$PROJECT_TWO"
    PROJECT_ONE="$(realpath "$PROJECT_ONE")"
    PROJECT_TWO="$(realpath "$PROJECT_TWO")"
    CLAUDE_FILE="$CLAUDE_SLUG/$CLAUDE_ONE.jsonl"
    CODEX_FILE="$ROLLOUT_ROOT/rollout-2026-07-24T12-00-00-$CODEX_ONE.jsonl"
    printf '{"type":"user","sessionId":"%s","cwd":"%s","gitBranch":"main","message":{"role":"user","content":"Claude smoke"}}\n' \
        "$CLAUDE_ONE" "$PROJECT_ONE" > "$CLAUDE_FILE"
    printf '{"timestamp":"2026-07-24T12:00:00.000Z","type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\n' \
        "$CODEX_ONE" "$PROJECT_ONE" > "$CODEX_FILE"
    sqlite3 "$SMOKE_CODEX_HOME/state_5.sqlite" \
        'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL, created_at_ms INTEGER, updated_at_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, git_sha TEXT, git_branch TEXT, git_origin_url TEXT);'
    sqlite3 "$SMOKE_CODEX_HOME/state_5.sqlite" \
        "INSERT INTO threads VALUES ('$CODEX_ONE', '$PROJECT_ONE', 'Codex smoke', '$CODEX_FILE', 0, 0, 0, 0, 0, NULL, 'main', NULL);"
    echo "agent-feed-sidecar-smoke: launching $BINARY on port $PORT"
    AGENT_FEED_PORT=$PORT \
        AGENT_FEED_HOST=127.0.0.1 \
        AGENT_FEED_CLAUDE_PROJECTS_DIR="$CLAUDE_ROOT" \
        AGENT_FEED_CODEX_HOME="$SMOKE_CODEX_HOME" \
        AGENT_FEED_PI_SESSIONS_DIR="$PI_SESSIONS_ROOT" \
        AGENT_FEED_DISCOVERY_RESCAN_MS=1000 \
        "$BINARY" > "$LOG_FILE" 2>&1 &
    SPID=$!
    INVENTORY_STREAM_PID=
    cleanup() {
        if [[ -n "$INVENTORY_STREAM_PID" ]]; then kill "$INVENTORY_STREAM_PID" 2>/dev/null || true; fi
        kill "$SPID" 2>/dev/null || true
        wait "$SPID" 2>/dev/null || true
        rm -rf "$SMOKE_ROOT"
    }
    trap cleanup EXIT
    for i in $(seq 1 100); do
        if curl -sf http://127.0.0.1:$PORT/api/config 2>/dev/null | grep -q '"watcherState":"live"'; then break; fi
        sleep 0.1
    done
    test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/config")" = "401"
    CFG=$(curl -sf "http://127.0.0.1:$PORT/api/config")
    echo "agent-feed-sidecar-smoke: /api/config -> ${CFG}"
    curl -sfG "http://127.0.0.1:$PORT/api/sessions" \
        --data-urlencode "projectPath=$PROJECT_ONE" -o "$SESSIONS_JSON"
    SESSIONS_FILE="$SESSIONS_JSON" bun -e \
        'const body=await Bun.file(process.env.SESSIONS_FILE).json();if(body.sessions.length!==2||!body.sessions.some((s)=>s.source==="claude")||!body.sessions.some((s)=>s.source==="codex"))throw new Error(JSON.stringify(body));'
    test "$(curl -sG -o /dev/null -w '%{http_code}' \
        \
        "http://127.0.0.1:$PORT/api/sessions/claude/$CLAUDE_ONE/events" \
        --data-urlencode 'offset=invalid')" = "400"

    # One stream for the whole inventory, which is what a surface actually opens: the
    # project list rides it unconditionally, and the session list of every project named
    # by a projectPath parameter rides it too. This was two streams and a JSON probe until
    # they were merged, and the connection budget between the panel and this process is
    # why -- so a smoke that reopened the old split shape would be testing a surface no
    # reader has.
    #
    # 20s rather than the 8 the two split streams had: this one connection now spans both
    # wait loops, and each can spend 5s of its own. It is a hang stop, not a deadline --
    # the trap kills the stream as soon as the assertions below are done.
    curl -NsG --max-time 20 \
        "http://127.0.0.1:$PORT/api/inventory/stream" \
        --data-urlencode "projectPath=$PROJECT_ONE" > "$INVENTORY_STREAM" &
    INVENTORY_STREAM_PID=$!
    # The opening messages, which are the same assertions the two probes made before the
    # merge: the project list names project one with one session from each source, and
    # project one's own list carries both of them.
    for i in $(seq 1 100); do
        if grep -q '"projects"' "$INVENTORY_STREAM" && grep -q '"sessions"' "$INVENTORY_STREAM"; then break; fi
        sleep 0.05
    done
    INVENTORY_FILE="$INVENTORY_STREAM" EXPECTED_PATH="$PROJECT_ONE" bun -e \
        'const text=await Bun.file(process.env.INVENTORY_FILE).text();const msgs=text.split("\n").filter((l)=>l.startsWith("data: ")).map((l)=>JSON.parse(l.slice(6)));const projects=msgs.find((m)=>m.projects);const sessions=msgs.find((m)=>m.projectPath===process.env.EXPECTED_PATH);if(!projects||projects.projects.length!==1||projects.projects[0].projectPath!==process.env.EXPECTED_PATH||projects.projects[0].sourceCounts.claude!==1||projects.projects[0].sourceCounts.codex!==1)throw new Error("projects: "+JSON.stringify(projects));if(!sessions||sessions.sessions.length!==2||!sessions.sessions.some((s)=>s.source==="claude")||!sessions.sessions.some((s)=>s.source==="codex"))throw new Error("sessions: "+JSON.stringify(sessions));'
    # A new project and a new session in an existing one, which exercise the two message
    # shapes the merged stream has to keep telling apart.
    printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"new project"}}\n' \
        "$CLAUDE_TWO" "$PROJECT_TWO" > "$CLAUDE_SLUG/$CLAUDE_TWO.jsonl"
    printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"new session"}}\n' \
        "$CLAUDE_THREE" "$PROJECT_ONE" > "$CLAUDE_SLUG/$CLAUDE_THREE.jsonl"
    for i in $(seq 1 100); do
        if grep -q "$PROJECT_TWO" "$INVENTORY_STREAM" && grep -q "$CLAUDE_THREE" "$INVENTORY_STREAM"; then break; fi
        sleep 0.05
    done
    grep -q "$PROJECT_TWO" "$INVENTORY_STREAM"
    grep -q "$CLAUDE_THREE" "$INVENTORY_STREAM"
    INVENTORY_BYTES=$(wc -c < "$INVENTORY_STREAM" | tr -d ' ')
    SESSION_BYTES=$(wc -c < "$SESSIONS_JSON" | tr -d ' ')
    echo "agent-feed-sidecar-smoke: /api/inventory/stream -> ${INVENTORY_BYTES} bytes"
    echo "agent-feed-sidecar-smoke: /api/sessions -> ${SESSION_BYTES} bytes"
    grep '"event":"agent-feed-' "$LOG_FILE"
    echo "agent-feed-sidecar-smoke: PASS"

# Makes the package's resource declarations valid without running the web build,
# for test lanes (sim-test) that never present the panel: it checks the fixture
# stub is present and prepares the ignored Vite output directory. The fixture is
# NOT a serving fallback -- AgentPanel refuses to load it (missingWebviewBuild),
# so any lane that shows a panel must depend on build-agent-webview instead.
ensure-webview-placeholder:
    #!/usr/bin/env bash
    set -euo pipefail
    test -f '{{justfile_directory()}}/packages/AgentPanel/Sources/AgentPanel/Resources/AgentPanelFixture/index.html'
    mkdir -p '{{webview_out}}'

# Test and build the single-file workspace viewer shipped in WorkspaceFileViewer.
# It used to emit the paired IDE regions from the same dependency tree; the IDE is the Agent Panel
# and the sidecar now (ADR-0115), so only the viewer is published from here.
workspace-ide-web:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    WEB="$ROOT/packages/WorkspaceIDE/Web"
    VIEWER_OUT="$ROOT/packages/WorkspaceIDE/Sources/WorkspaceFileViewer/Resources/viewer"
    STAGING="$(mktemp -d "${TMPDIR:-/tmp}/agentdesk-workspace-ide.XXXXXX")"
    cleanup() {
      rm -rf "$STAGING"
    }
    trap cleanup EXIT
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" workspace-ide "$WEB" "$ROOT/.build/js-dependencies"
    pnpm --dir "$WEB" test
    pnpm --dir "$WEB" run build "$STAGING"
    node "$ROOT/tools/build-system/publish-generated-tree.mjs" "$STAGING/viewer" "$VIEWER_OUT"
    just workspace-ide-fitness

# Package-move fitness: no stale package tree or generated dependency tree may enter Swift resources.
workspace-ide-fitness:
    #!/usr/bin/env bash
    set -euo pipefail
    test ! -e '{{justfile_directory()}}/packages/WorkspaceEditorViewer'
    test -f '{{justfile_directory()}}/packages/WorkspaceIDE/Package.swift'
    # The published tree is a self-contained document: its own index.html plus the hashed assets
    # Vite emitted for it. Asserting the directory rather than a filename keeps this honest across
    # content hashes, which change on every meaningful edit.
    test -f '{{justfile_directory()}}/packages/WorkspaceIDE/Sources/WorkspaceFileViewer/Resources/viewer/index.html'
    test -d '{{justfile_directory()}}/packages/WorkspaceIDE/Sources/WorkspaceFileViewer/Resources/viewer/assets'
    test -f '{{justfile_directory()}}/packages/WorkspaceIDE/Web/src/viewerBootstrap.ts'
    # The IDE's document used to be published beside the viewer. It is the Agent Panel's
    # `?entry=ide` surface now (ADR-0115), so its absence is the fitness check.
    test ! -e '{{justfile_directory()}}/packages/WorkspaceIDE/Sources/WorkspaceIDE'
    test ! -e '{{justfile_directory()}}/packages/WorkspaceIDE/Web/src/ide.ts'
    if find '{{justfile_directory()}}/packages/WorkspaceIDE/Sources' -type d -name node_modules -print -quit | grep -q .; then
        echo 'workspace-ide-fitness: node_modules found inside Swift package resources' >&2
        exit 1
    fi

workspace-ide-test: workspace-ide-fitness
    cd packages/WorkspaceIDE && swift test

# Build AgentPanel's owned Vite project into its Swift package resources.
build-agent-webview:
    #!/usr/bin/env bash
    set -euo pipefail
    WEB='{{agent_panel_web_dir}}'
    OUT='{{webview_out}}'
    STAMP='{{stamps_dir}}/agent-webview'
    HASH="$('{{source_hash}}' "$WEB")"
    if [ -f "$OUT/index.html" ] && [ "$HASH" = "$(cat "$STAMP" 2>/dev/null || true)" ]; then
        echo "build-agent-webview: source unchanged, skipping"
        exit 0
    fi
    echo "build-agent-webview: building AgentPanel Web"
    node '{{justfile_directory()}}/tools/build-system/ensure-js-dependencies.mjs' \
      agent-panel "$WEB" '{{justfile_directory()}}/.build/js-dependencies'
    cd "$WEB" && bun run build
    node '{{justfile_directory()}}/tools/build-system/publish-generated-tree.mjs' \
      "$WEB/dist" "$OUT" --preserve .gitkeep
    mkdir -p '{{stamps_dir}}'; printf '%s\n' "$HASH" > "$STAMP"
    echo "build-agent-webview: DONE"

# Three-owner fitness: the sidecar owns the feed's model, the panel owns the view, Swift owns
# transport and native authority and names no payload field.
agent-feed-fitness:
    sh '{{justfile_directory()}}/tools/agent-feed-fitness.sh'

# Installs this repository's git hooks, which are tracked so every checkout gets the same ones.
#
# One symlink into the COMMON git directory, which is what every linked worktree shares -- so
# installing once here covers the worktrees under `.claude/worktrees/` as well, including ones
# that do not exist yet. Idempotent, and it refuses to replace a hook it did not put there rather
# than silently discarding somebody's own.
git-hooks-install:
    #!/usr/bin/env bash
    set -euo pipefail
    SOURCE='{{justfile_directory()}}/tools/git-hooks/pre-commit'
    HOOKS="$(git -C '{{justfile_directory()}}' rev-parse --git-common-dir)/hooks"
    mkdir -p "$HOOKS"
    TARGET="$HOOKS/pre-commit"
    if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
        echo "git-hooks-install: $TARGET exists and is not a symlink; move it aside first" >&2
        exit 1
    fi
    ln -sfn "$SOURCE" "$TARGET"
    echo "git-hooks-install: pre-commit -> $SOURCE"

# Issue (or renew) the panel dev server's TLS certificate for this Mac's MagicDNS name.
#
# Tailscale gets a publicly trusted certificate for the name from Let's Encrypt, which is the
# whole trick behind the phone's HMR loop: the iPhone client ships to a daily driver through
# TestFlight, so an App Transport Security exception opened for dev convenience is exactly the kind
# that survives into a release build. A real certificate needs no exception (ADR-0096).
#
# Idempotent by --min-validity: an existing certificate with more than a week left is reused, and
# `tailscale cert` only goes to the CA when it is not. Note the name enters public Certificate
# Transparency logs, as any publicly trusted certificate does.
#
# Prints the path PREFIX on stdout; the two files are that plus `.crt` and `.key`. Everything the
# command itself has to say goes to stderr, so a caller can read the prefix straight out of it.
agent-webview-dev-cert:
    #!/usr/bin/env bash
    set -euo pipefail
    NAME="$(sh '{{justfile_directory()}}/tools/tailnet-dns-name.sh')"
    DIR='{{agent_panel_dev_tls_dir}}'
    umask 077
    mkdir -p "$DIR"
    tailscale cert --min-validity 168h \
      --cert-file "$DIR/$NAME.crt" --key-file "$DIR/$NAME.key" "$NAME" >&2
    echo "$DIR/$NAME"

# Bring the panel's Vite dev server up if it is not already. Prints its origin, and nothing else.
#
# This is what makes the live panel the DEFAULT rather than a thing you remember to set up: every
# host and client launch calls it, an already-running server is reused, and a server that cannot
# come up fails the launch instead of letting it start against an origin nothing is serving. That
# last part is the whole reason this is a wait-and-verify loop and not a bare `&': the dev origin is
# not a fallback, so a launch that races Vite's binding gets a panel that never loads.
#
# One https origin serves both surfaces. Not a preference: TLS is a property of the port, so once
# the phone's certificate is loaded there is no http on it for the Mac to keep using, and the Mac
# reaching its own tailnet name is the smaller cost of the two. Everything the panel actually DOES
# still goes through each host's own relay, so one page origin does not mean one sidecar.
#
# `feed_origin` is where this server's /api proxy sends the plain-browser leg, and it is the ONE
# thing here that is per-host-tier rather than shared: a browser has no relay, so it reaches the
# sidecar through Vite. One server means one target, so the browser leg follows whichever host
# started the server. Launch the other tier's host and its webview and phone are unaffected -- they
# go through their own relay -- but a browser tab still talks to the first one's sidecar.
agent-webview-dev-ensure port=agent_panel_dev_port feed_origin="http://127.0.0.1:7682":
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    WEB='{{agent_panel_web_dir}}'
    LOG='{{agent_panel_dev_log}}'
    NAME="$(sh "$ROOT/tools/tailnet-dns-name.sh")"
    TLS_PREFIX='{{agent_panel_dev_tls_dir}}'/"$NAME"
    ORIGIN="https://$NAME:{{port}}"
    # `/@vite/client` rather than `/`, because this asks a narrower question: not "is something
    # listening on this port" but "is that something a Vite dev server". An unhealthy listener
    # or missing runtime credentials must be replaced before a host adopts this origin.
    # --noproxy: this shell inherits HTTPS_PROXY (proxy-agent) with only loopback in NO_PROXY, so
    # without it the probe to the tailnet name is tunnelled through the proxy instead of reaching Vite.
    serving() { curl -fs --noproxy '*' -o /dev/null --max-time 4 "$ORIGIN/@vite/client"; }
    if serving && [ -s "$TLS_PREFIX.crt" ] && [ -s "$TLS_PREFIX.key" ]; then
        echo "agent-webview-dev: already serving at $ORIGIN" >&2
        echo "$ORIGIN"
        exit 0
    fi
    echo "agent-webview-dev: preparing $ORIGIN (server unavailable or durable credentials missing)" >&2
    # Stop first, including a listener whose TLS can no longer answer the probe. The existing
    # port reclaimer is a no-op on a cold start and fails if it cannot stop.
    just agent-webview-dev-stop '{{port}}' >&2
    CERT="$(just agent-webview-dev-cert)"
    # stdout of this recipe IS the origin, so everything else here goes to stderr. Without the
    # redirect the dependency check's own chatter is prepended to the captured value and the host
    # is handed a two-line "origin" it can only refuse -- which it does, loudly, on both surfaces.
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" agent-panel "$WEB" "$ROOT/.build/js-dependencies" >&2
    : > "$LOG"
    # Detached, because the launch that called this outlives it and a dev server that died with the
    # recipe would make every launch the last one that worked.
    (
        cd "$WEB"
        AGENTDESK_AGENT_PANEL_HOST="$NAME" \
        AGENTDESK_AGENT_PANEL_TLS_CERT="$CERT.crt" \
        AGENTDESK_AGENT_PANEL_TLS_KEY="$CERT.key" \
        AGENTDESK_AGENT_FEED_ORIGIN='{{feed_origin}}' \
        nohup bun run dev --port '{{port}}' --strictPort </dev/null >>"$LOG" 2>&1 &
    )
    # 20s by default, as 100 attempts a fifth of a second apart. Overridable because the
    # failure path is exercised by a test that has no server to wait for and would otherwise
    # spend the whole budget proving it: the test sets a handful of attempts, a real launch
    # keeps the twenty seconds a cold Vite start can need.
    ATTEMPTS="${AGENTDESK_AGENT_PANEL_DEV_READY_ATTEMPTS:-100}"
    for _ in $(seq 1 "$ATTEMPTS"); do
        if serving; then
            echo "agent-webview-dev: serving at $ORIGIN (log: $LOG)" >&2
            echo "$ORIGIN"
            exit 0
        fi
        sleep 0.2
    done
    echo "ERROR: no Vite dev server at $ORIGIN after $ATTEMPTS attempts. Its output is in $LOG." >&2
    echo "       The panel would load from nothing, so this launch stops here. Pass" >&2
    echo "       'panel=bundled' to use the built webview instead." >&2
    exit 1

# Serve the Agent Panel from Vite in the FOREGROUND, with its log on your terminal.
#
# Host launches start this server themselves (see agent-webview-dev-ensure), so reach for this one
# when you want to watch its log on your own terminal. It mints the same control token that one
# does, into the same file, so the plain-browser leg works either way -- the host launched after it
# adopts the token and the /api proxy can then answer a browser that has no relay of its own.
#
# The dev origin is NOT a fallback: with it set, the host serves only from Vite, and if Vite is not
# up the panel fails to load rather than quietly showing the bundled build.
agent-webview-dev port=agent_panel_dev_port feed_origin="http://127.0.0.1:7682":
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    WEB='{{agent_panel_web_dir}}'
    NAME="$(sh "$ROOT/tools/tailnet-dns-name.sh")"
    ORIGIN="https://$NAME:{{port}}"
    # Refuse rather than let --strictPort fail with a bare EADDRINUSE: the likely occupant is the
    # server a launch started, and the reason you are running this one by hand is usually an
    # environment that one does not have.
    if curl -fs -o /dev/null --max-time 4 "$ORIGIN/@vite/client"; then
        echo "a Vite dev server is already at $ORIGIN, probably started by a host or client launch." >&2
        echo "Run 'just agent-webview-dev-stop' first to replace it with this one." >&2
        exit 1
    fi
    CERT="$(just agent-webview-dev-cert)"
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" agent-panel "$WEB" "$ROOT/.build/js-dependencies"
    echo "agent-webview-dev: serving at $ORIGIN"
    echo "  hosts launched from here point at it automatically ({{agent_panel_origin_var}}),"
    echo "  and each host tells its attached phones to load from it too"
    echo ""
    cd "$WEB"
    AGENTDESK_AGENT_PANEL_HOST="$NAME" \
    AGENTDESK_AGENT_PANEL_TLS_CERT="$CERT.crt" \
    AGENTDESK_AGENT_PANEL_TLS_KEY="$CERT.key" \
    AGENTDESK_AGENT_FEED_ORIGIN='{{feed_origin}}' \
    bun run dev --port '{{port}}' --strictPort

# Stop whatever holds the panel dev-server port. The next host launch starts a fresh one.
agent-webview-dev-stop port=agent_panel_dev_port:
    #!/usr/bin/env bash
    set -euo pipefail
    sh '{{justfile_directory()}}/tools/reclaim-port.sh' "agent panel dev server" '{{port}}'

# Whether a PLAIN BROWSER tab at the dev origin can actually load data.
#
# Worth its own recipe because this is the one leg that can fail silently in a way nothing else
# notices: the Mac panel and the phone reach the sidecar through their own relay, so they keep
# working perfectly while a browser tab shows an empty feed. The usual cause is a host that was
# launched before its dev server, or one that adopted a token from a server since replaced.
agent-webview-dev-status port=agent_panel_dev_port:
    #!/usr/bin/env bash
    set -euo pipefail
    NAME="$(sh '{{justfile_directory()}}/tools/tailnet-dns-name.sh')"
    ORIGIN="https://$NAME:{{port}}"
    # Probed on the inventory stream, which carries the whole surface's data since 469e7938
    # put it on one connection. That commit removed /api/projects, which this probed until
    # it started reporting a dead sidecar at a stack that was serving perfectly.
    #
    # A serving stream never ends on its own, so curl always exits on the timeout it was
    # given and the timeout is the cost of the check, not a symptom. `|| true` rather than
    # `|| echo 000`: curl has already printed the response code by then, and the echo would
    # concatenate onto it and match no case below.
    #
    # Retried, because the honest sequence is `host-run && agent-webview-dev-status` and the two
    # do not finish together: `host-run` returns when the app is launched, and the sidecar binds
    # its port a second or two later. Until it does, the proxy has nothing to reach and answers
    # 5xx -- a real failure code for a host that is merely still starting. Only that shape is
    # retried; a 200 is done and a 401 is a token disagreement that waiting cannot fix.
    PROBE="$ORIGIN/api/inventory/stream"
    for _ in $(seq 1 15); do
        CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$PROBE" || true)"
        CODE="${CODE:-000}"
        case "$CODE" in
            5*) sleep 1 ;;
            *) break ;;
        esac
    done
    case "$CODE" in
        200)
            echo "browser leg OK: $ORIGIN loads its own data"
            # The protocol, not just the status. `server.https` gives this origin TLS AND HTTP/2,
            # but Vite downgrades it to TLS-only the moment a `server.proxy` entry exists -- and
            # under HTTP/1.1 a browser allows about six connections per origin while the panel
            # holds an EventSource for the catalog, the transcript, tasks, the summary, usage,
            # bots, the session board and the terminals. The stream that loses the race never
            # opens, silently: the terminal that waits on it just says "Opening terminal" for
            # ever. That cost an evening, so the version is checked here rather than assumed.
            VERSION="$(curl -sk -o /dev/null -w '%{http_version}' --max-time 3 "$ORIGIN/api/config" || true)"
            case "$VERSION" in
                2*) echo "  negotiated HTTP/$VERSION, so its event streams are multiplexed" ;;
                *)
                    echo "browser leg DOWNGRADED: $ORIGIN negotiated HTTP/${VERSION:-unknown}," >&2
                    echo "  not HTTP/2, so the panel's event streams compete for ~6 connections" >&2
                    echo "  and whichever opens last (usually the terminals stream) never opens." >&2
                    echo "  A 'server.proxy' entry in packages/AgentPanel/Web/vite.config.ts is" >&2
                    echo "  what turns HTTP/2 off; proxy through the panelSessions middleware" >&2
                    echo "  instead." >&2
                    exit 1
                    ;;
            esac
            ;;
        401)
            echo "browser leg UNAUTHORIZED: the dev server's token is not the one this host's" >&2
            echo "  sidecar accepts. Relaunch the host so it adopts the running server's token," >&2
            echo "  or 'just agent-webview-dev-stop' and relaunch to get a matching pair." >&2
            exit 1
            ;;
        000)
            echo "no dev server answering at $ORIGIN. Start one with a host launch," >&2
            echo "  or 'just agent-webview-dev' to watch it." >&2
            exit 1
            ;;
        *)
            echo "browser leg answered $CODE at $PROBE, which is neither a working feed nor an" >&2
            echo "  auth failure. A 5xx outlasted the sidecar's startup window, so it is not" >&2
            echo "  listening on the port this server proxies to. A 404 means this recipe is" >&2
            echo "  probing a route the sidecar no longer serves -- check it against the" >&2
            echo "  pathnames in agent-feed/sidecar/src/http/ before believing the stack is" >&2
            echo "  broken. Its log: {{agent_panel_dev_log}}" >&2
            exit 1
            ;;
    esac

agent-panel-web-check:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    WEB='{{agent_panel_web_dir}}'
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" agent-panel "$WEB" "$ROOT/.build/js-dependencies"
    cd "$WEB"
    bun run typecheck
    bun run test

# The JS that builds and publishes every generated tree in this repo. On the current path,
# so it stays in the fast gate.
build-system-check:
    #!/usr/bin/env bash
    set -euo pipefail
    node --test tools/build-system/*.test.mjs

# The shell scripts in `tools/` that drive host-run, the client install, the launch environment,
# port and pid reclaiming, telemetry and TestFlight upload, each tested by its `-tests.sh` beside it,
# plus the media architecture guard. Plain shell with stubbed commands, about 10s, nothing built, so
# an edit to `tools/` runs these rather than every leg of the gate. `swift-check` runs them too.
tools-check:
    #!/usr/bin/env bash
    set -euo pipefail
    sh tools/media-architecture-guard.sh
    sh tools/exact-executable-pids-tests.sh
    sh tools/local-udp-port-pids-tests.sh
    sh tools/reclaim-port-tests.sh
    sh tools/host-run-lifecycle-tests.sh
    sh tools/client-install-lifecycle-tests.sh
    sh tools/launch-env-tests.sh
    sh tools/hybrid-graphics-diagnostics-summary-tests.sh
    sh tools/host-client-telemetry-tests.sh
    sh tools/testflight-upload-tests.sh

# The Swift capture-and-input helper the sidecar spawns for every desktop stream. It is compiled,
# but it is on the current path, so unlike the rest of the Swift in this repo it belongs in the
# fast gate. Compiles the helper and runs its input-controller and navigation suites.
grid-encoder:
    #!/usr/bin/env bash
    set -euo pipefail
    sh tools/test-desktop-input-controller.sh
    sh tools/test-desktop-navigation.sh
    sh tools/build-grid-encoder.sh

# Build the gesture/voice interaction webview bundle into InteractionPanel's
# package resources. The gesture-agent web app is the authored renderer; its
# Vite embed output is content-published before the consuming app build.
# Requires pnpm on PATH.
build-gesture-webview:
    #!/usr/bin/env bash
    set -euo pipefail
    WEB='{{gesture_web_dir}}'
    OUT='{{gesture_webview_out}}'
    STAMP='{{stamps_dir}}/gesture-webview'
    HASH="$('{{source_hash}}' "$WEB")"
    if [ -f "$OUT/index.html" ] && [ "$HASH" = "$(cat "$STAMP" 2>/dev/null || true)" ]; then
        echo "build-gesture-webview: web unchanged, skipping"
        exit 0
    fi
    echo "build-gesture-webview: running pnpm build:embed in $WEB"
    node '{{justfile_directory()}}/tools/build-system/ensure-js-dependencies.mjs' \
      gesture-webview "$WEB" '{{justfile_directory()}}/.build/js-dependencies'
    cd "$WEB" && pnpm build:embed
    node '{{justfile_directory()}}/tools/build-system/publish-generated-tree.mjs' \
      "$WEB/gesture-webview-dist" "$OUT" --preserve .gitkeep
    mkdir -p '{{stamps_dir}}'; printf '%s\n' "$HASH" > "$STAMP"
    echo "build-gesture-webview: DONE"

# Stage the voice sidecar's Python inputs into the host app source tree: the `uv`
# binary and a read-only copy of the interaction-agent source (pyproject.toml +
# uv.lock + src, WITHOUT the heavy data/ models tree — models are fetch-and-cached
# to Application Support at runtime), plus the complete locked Python 3.13 wheel
# wheelhouse. The first-launch VoiceVenvProvisioner installs from those bundled wheels
# with networking and its cache disabled (core deps, no `desktop` extra).
#
# NOTE (Xcode inclusion): `uv` is a single file and is picked up as a bundle
# resource by the synchronized root group like `agent-feed-sidecar`. `voice-src/`
# and `voice-wheelhouse/` are folder references, preserving both trees under
# `Contents/Resources/`. ZIPA model staging is not an input: the runtime reads
# installed Application Support assets, so packaging must survive build-cache deletion.
build-voice-sidecar:
    #!/usr/bin/env bash
    set -euo pipefail
    SRC='{{gesture_agent_dir}}'
    UV_OUT='{{voice_uv_out}}'
    SRC_OUT='{{voice_src_out}}'
    WHEELHOUSE_OUT='{{voice_wheelhouse_out}}'
    WHEELHOUSE_BUILDER='{{justfile_directory()}}/tools/build-system/build-voice-wheelhouse.sh'
    WHEELHOUSE_CONSTRAINTS='{{justfile_directory()}}/tools/build-system/voice-build-constraints.txt'
    UV_BIN="$(command -v uv)"
    CMU_DICT='{{voice_assets_src}}/VoiceCMUDictionary.txt'
    PHONE_MAP='{{voice_assets_src}}/arpabet-model-phone-map.json'
    if [ -z "$UV_BIN" ]; then echo "build-voice-sidecar: uv not on PATH" >&2; exit 1; fi
    if [ ! -f "$SRC/pyproject.toml" ]; then echo "build-voice-sidecar: no pyproject at $SRC" >&2; exit 1; fi
    if [ ! -f "$SRC/uv.lock" ]; then echo "build-voice-sidecar: no uv.lock at $SRC (run 'uv lock')" >&2; exit 1; fi
    STAMP='{{stamps_dir}}/voice-sidecar'
    # Hash package inputs, pinned pronunciation assets, the wheelhouse builder/constraints,
    # and the uv binary, never the whole tree (its data/ holds a ~500 MB model).
    HASH="$('{{source_hash}}' "$SRC/pyproject.toml" "$SRC/uv.lock" "$SRC/src" "$UV_BIN" "$CMU_DICT" "$PHONE_MAP" "$WHEELHOUSE_BUILDER" "$WHEELHOUSE_CONSTRAINTS")"
    if [ -x "$UV_OUT" ] && [ -f "$SRC_OUT/pyproject.toml" ] && [ -f "$SRC_OUT/stage-hash" ] && [ -f "$WHEELHOUSE_OUT/SHA256SUMS" ] && [ "$HASH" = "$(cat "$WHEELHOUSE_OUT/.stage-hash" 2>/dev/null || true)" ] && [ "$HASH" = "$(cat "$STAMP" 2>/dev/null || true)" ]; then
        if (cd "$WHEELHOUSE_OUT" && shasum -a 256 -c SHA256SUMS >/dev/null); then
            echo "build-voice-sidecar: inputs unchanged, skipping"
            exit 0
        fi
        echo "build-voice-sidecar: wheelhouse checksum mismatch; rebuilding" >&2
    fi
    echo "build-voice-sidecar: building offline wheelhouse -> $WHEELHOUSE_OUT"
    "$WHEELHOUSE_BUILDER" "$UV_BIN" "$SRC" "$WHEELHOUSE_OUT" "$HASH"
    echo "build-voice-sidecar: staging uv -> $UV_OUT"
    cp -f "$UV_BIN" "$UV_OUT"
    chmod +x "$UV_OUT"
    echo "build-voice-sidecar: staging interaction-agent source -> $SRC_OUT"
    rm -rf "$SRC_OUT"
    mkdir -p "$SRC_OUT"
    cp "$SRC/pyproject.toml" "$SRC/uv.lock" "$SRC_OUT/"
    [ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$SRC_OUT/" || true
    # Stage the exact pinned assets from their one tracked home so the installed
    # Python sidecar derives the same Passage reference view as the phone.
    cp "$CMU_DICT" "$PHONE_MAP" "$SRC_OUT/"
    # src/ only — exclude data/ (models), __pycache__, and any local venv.
    rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '*.egg-info' "$SRC/src" "$SRC_OUT/"
    # Ride the same hash into the bundle. The runtime venv holds a COPY of this
    # source, so VoiceVenvProvisioner stamps it with this value and rebuilds when
    # the content moves — the app's marketing version does not track Python edits
    # and a stale venv silently keeps serving the old code (Config.swift reads it).
    printf '%s\n' "$HASH" > "$SRC_OUT/stage-hash"
    mkdir -p '{{stamps_dir}}'; printf '%s\n' "$HASH" > "$STAMP"
    echo "build-voice-sidecar: DONE"

# Live check of the voice sidecar's recordings REST surface: newest-first
# ordering, wav playback, delete, and cross-origin readability from the embedded
# panel's origin. Boots its own server on a scratch data root (never touches the
# real recordings) and tears it down. NOT part of `just check`: it spins up the
# Python voice stack, which is far slower than the rest of that gate.
voice-recordings-smoke port="7699":
    #!/usr/bin/env bash
    set -euo pipefail
    listeners() { lsof -nP -iTCP:'{{port}}' -sTCP:LISTEN -t 2>/dev/null || true; }
    # Refuse to run against someone else's server: the checks would pass or fail
    # for reasons that have nothing to do with this tree, and cleanup would kill
    # a process we do not own.
    if [ -n "$(listeners)" ]; then
        echo "voice-recordings-smoke: port {{port}} is already in use" >&2
        exit 1
    fi
    DATA_ROOT="$(mktemp -d)"
    # Kill by port, not by the pid of the backgrounded subshell: `uv run` spawns
    # the python server as a grandchild, so killing the subshell leaves the
    # server holding the port and the next run would silently test a stale one.
    cleanup() {
        PIDS="$(listeners)"
        [ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
        rm -rf "$DATA_ROOT"
    }
    trap cleanup EXIT
    echo "voice-recordings-smoke: data root $DATA_ROOT"
    (cd '{{gesture_agent_dir}}' && VOICE_HOST=127.0.0.1 VOICE_PORT='{{port}}' \
        VOICE_DATA_ROOT="$DATA_ROOT" uv run voice-server >"$DATA_ROOT/server.log" 2>&1) &
    for _ in $(seq 1 60); do
        curl -sf -m 2 "http://127.0.0.1:{{port}}/health" >/dev/null 2>&1 && break
        sleep 1
    done
    if ! curl -sf -m 2 "http://127.0.0.1:{{port}}/health" >/dev/null 2>&1; then
        echo "voice-recordings-smoke: server never became ready" >&2
        tail -20 "$DATA_ROOT/server.log" >&2 || true
        exit 1
    fi
    /usr/bin/python3 tools/voice-recordings-api-tests.py "http://127.0.0.1:{{port}}"

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
# Loads the real MV3 extension (rrweb isolated-world recorder, password masking ON) into a throwaway
# Chrome profile via
# Playwright, records the CSP-strict fixture through the real connectNative -> shim -> fake host
# chain, and asserts checkout + events + ordinary-content-present + password-masked. Uses the globally
# installed Playwright and Chrome for Testing; no browser download.
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

# Pure projection-session and shared-renderer gates. This recipe never launches the native host or
# visible Chrome; the renderer contract runs in a test-owned headless browser.
browser-projection-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    node '{{justfile_directory()}}/chrome-test/browser-session-verify.cjs'
    node '{{justfile_directory()}}/chrome-test/source-viewport-verify.cjs'
    node '{{justfile_directory()}}/chrome-test/browser-metadata-verify.cjs'
    node '{{justfile_directory()}}/chrome-test/browser-projection-renderer-verify.mjs'
    swift test --package-path '{{justfile_directory()}}/packages/BrowserProjection'

# Full local multi-window acceptance gate. It owns a visible Chrome-for-Testing profile and the dev
# host, drives only stable AX identifiers, writes window-only screenshots under /tmp, and removes all
# test-owned processes and profile state. The personal Chrome profile and stable host are untouched.
browser-projection-e2e: ext-stamp
    #!/usr/bin/env bash
    set -euo pipefail
    just browser-projection-verify
    just dom-mirror-input-verify
    just dom-mirror-scroll-verify
    AGENTDESK_E2E_HOST_SUPPORT='{{host_dev_support_dir}}' \
      AGENTDESK_E2E_HOST_DERIVED_DATA='{{host_dev_derived_data}}' \
      node '{{justfile_directory()}}/chrome-test/browser-projection-e2e.mjs'

# Visible, test-owned PTY replay and standalone-window restoration acceptance gate. It preflights
# TCC without prompting, uses a temporary socket and manager, exercises two differently sized
# production web-terminal windows plus a deliberately slow client, restarts the test host harness without killing
# the manager, and writes bounded artifacts under /tmp. It never touches the personal host socket.
terminal-replay-e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    bash '{{justfile_directory()}}/tools/terminal-replay-e2e.sh' '{{justfile_directory()}}'

# Check and publish the deterministic shared terminal web runtime from the audited xterm fork.
terminal-web-check:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT='{{justfile_directory()}}'
    WEB="$ROOT/terminal/pty-client-swift/Web"
    OUTPUT="$ROOT/terminal/pty-client-swift/Sources/PtyTerminalWebView/Resources/Web"
    STAGING="$(mktemp -d "${TMPDIR:-/tmp}/agentdesk-terminal-web.XXXXXX")"
    cleanup() {
      rm -rf "$STAGING"
    }
    trap cleanup EXIT
    node "$ROOT/tools/build-system/ensure-js-dependencies.mjs" terminal-web "$WEB" "$ROOT/.build/js-dependencies"
    cd "$WEB"
    pnpm test
    node "$ROOT/terminal/vendor/xterm/scripts/check-built-module.mjs"
    pnpm run build "$STAGING" "$OUTPUT"
    node "$ROOT/tools/build-system/publish-generated-tree.mjs" \
      "$STAGING" "$OUTPUT" \
      --preserve index.html \
      --preserve JetBrainsMonoNerdFontMono-Regular.ttf
    pnpm run check-generated

# ADR-0044 Tier B autonomous gate: capture a REAL DOMSnapshot.captureSnapshot (piercing a CLOSED
# shadow root) via Playwright's CDP session, run it through the SAME reconstructProjectionHtml the
# service worker uses, and assert the closed-shadow subtree plus ordinary content are captured while
# passwords stay masked. Uses the global Playwright + Chrome for Testing; the extension is not loaded.
dom-mirror-cdp-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    node '{{justfile_directory()}}/chrome-test/cdp-verify.mjs'

# Syntax highlighting is PAINTED, not merely emitted, on both surfaces that highlight. Needs a live
# panel. Guards a failure no unit test can see: Shiki writes its colours as custom properties, so a
# stylesheet scoped to one surface leaves the other tokenised and grey with nothing to notice.
panel-highlight-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://$(sh '{{justfile_directory()}}/tools/tailnet-dns-name.sh'):5173}" \
      node '{{justfile_directory()}}/chrome-test/panel-highlight-verify.mjs'

# Checks that the panel comes back to where it was being read, in a browser that lays pages out.
# NOT in `just check`: it needs a live panel (`just host-run`) and the sessions on this machine.
# Loopback rather than the tailnet name, because nothing here is about transport and the tailnet
# leg has its own check (`agent-webview-dev-status`); a DNS wobble on it is not this test failing.
# Override with PANEL_ORIGIN to point at the tailnet origin or another machine's.
# The unit tests cannot see what this does -- jsdom measures no rows, so a transcript's layout is
# settled from the first commit there and a restore can never be left behind by it.
panel-scroll-memory-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      PANEL_PROJECT='{{justfile_directory()}}' \
      node '{{justfile_directory()}}/chrome-test/panel-scroll-memory-verify.mjs'

# Checks the Desktop viewer's trackpad deck with real touch in a phone-sized Chrome for Testing.
# NOT in `just check`: it needs a live panel (`just host-run`). Every pointer input the page would
# send is recorded and dropped in the page, so the Mac under it is never clicked or scrolled; it
# does open the Desktop surface, which costs the sidecar one more encoder while it runs.
trackpad-deck-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://$(sh '{{justfile_directory()}}/tools/tailnet-dns-name.sh'):5173}" \
      node '{{justfile_directory()}}/chrome-test/trackpad-deck-verify.mjs'

# Checks a long message survives Claude collapsing it into a `[Pasted text #N]` handle.
# NOT in `just check`: it needs a live panel (`just host-run`) and it starts its own throwaway
# Claude session to type into, because it drives the composer it is testing.
# The unit test pins the reconciliation rule against a fake stream; both halves of what this
# checks live outside the panel -- the collapse in the CLI's renderer, the reading in the sidecar.
composer-paste-collapse-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      PANEL_PROJECT='{{justfile_directory()}}' \
      node '{{justfile_directory()}}/chrome-test/composer-paste-collapse-verify.mjs'

# Checks a file a session handed over can actually be opened from the feed.
# NOT in `just check`: it needs a live panel (`just host-run`) and a real handover in this
# project's history, since Claude's own directory is read-only to us and there is nowhere to
# seed one. Three of its assertions are outside the panel entirely -- the sidecar's answer, the
# dev origin's proxy passing that answer's headers, and whether the opened page really lands in
# an opaque origin, which is what keeps it from calling `/api` as the reader.
sent-file-link-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      PANEL_PROJECT='{{justfile_directory()}}' \
      node '{{justfile_directory()}}/chrome-test/sent-file-link-verify.mjs'

# Checks the Bot canvas's zoom mode in a browser that lays pages out.
# NOT in `just check`: it needs a live panel (`just host-run`) and the Bots on this machine.
# The unit tests cannot see any of this -- jsdom measures nothing, so the hook never learns a size
# and a focal-point assertion there would pass against an implementation that ignored the pointer.
# Two things here cannot be settled by reading at all: whether `touch-action: pan-x pan-y` leaves
# both touch points reaching the listeners while one finger still scrolls natively, and whether
# `inert` really takes the strip out of hit-testing so a press lands on the scroller under it.
canvas-zoom-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      node '{{justfile_directory()}}/chrome-test/canvas-zoom-verify.mjs'

# Checks that a wheel over a peer's FULLSCREEN pane reaches the program, and that one over an
# ordinary pane still sends it nothing. Needs a live panel and a peer with both kinds of pane on it:
# the fullscreen one is found by its tmux flags rather than named. WHEEL_MACHINE picks the peer.
terminal-wheel-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      node '{{justfile_directory()}}/chrome-test/terminal-wheel-verify.mjs'

# Checks that the faces switch trades initials for generated faces on every ranked
# avatar, and back again. Needs a live panel with at least one Bot: the roster and the canvas
# cards move together, a reload keeps the choice, and the run puts the switch back off.
bot-faces-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      node '{{justfile_directory()}}/chrome-test/bot-faces-verify.mjs'

# Checks the Bot file viewer keeps a long markdown file inside its modal, at desktop and phone
# widths. NOT in `just check`: it needs a live panel (`just host-run`) and the AD bot, whose
# directory holds the AGENTS.md it opens. jsdom measures nothing, so the clipping this guards --
# an auto grid row plus min-width:auto columns pushing the file column past the modal -- is
# invisible to the unit tests.
bot-code-dialog-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      node '{{justfile_directory()}}/chrome-test/bot-code-dialog-verify.mjs'

# The IDE's quick open and text search on the live panel: double Shift, Cmd+Shift+F, a result
# landing on its line. Opens tabs in the first workspace and closes the ones it opened (ADR-0123).
ide-search-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_PATH="$(npm root -g)"
    PANEL_ORIGIN="${PANEL_ORIGIN:-https://127.0.0.1:5173}" \
      node '{{justfile_directory()}}/chrome-test/ide-search-verify.mjs'

# ADR-0038 Phase 4 read-only-v1 acceptance test: the full three-process chain (real host with DOM
# mirror on + paired sim client + real Chrome-for-Testing extension). Chrome records the CSP-strict
# fixture; the batch flows extension -> shim -> host -> .dom QUIC lane -> sim client -> replay
# surface, which emits a probe of the reconstructed DOM. Asserts the sim console shows the capture
# marker (the probe uses a stable data attribute + node count rather than depending on fixture copy).
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
      kill $(sh tools/exact-executable-pids.sh '{{host_app}}/Contents/MacOS/AgentDeskHost') 2>/dev/null || true
      for v in AGENTDESK_AUTO_APPROVE AGENTDESK_DEV_ITERATION_RUN AGENTDESK_DOM_MIRROR_ENABLED; do launchctl unsetenv "$v" 2>/dev/null || true; done
    }
    trap cleanup EXIT

    echo "== build + launch host with DOM mirror enabled =="
    sh tools/xcodebuild-quiet.sh -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath '{{derived_data}}' PRODUCT_BUNDLE_IDENTIFIER='{{host_bundle_id}}' MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build
    kill $(sh tools/exact-executable-pids.sh '{{host_app}}/Contents/MacOS/AgentDeskHost') 2>/dev/null || true; sleep 1
    node tools/build-system/install-runtime.mjs host '{{host_build_app}}' '{{host_app}}' '{{host_bundle_id}}'
    just grid-encoder-install
    launchctl setenv AGENTDESK_AUTO_APPROVE 1
    launchctl setenv AGENTDESK_DEV_ITERATION_RUN 1
    launchctl setenv AGENTDESK_DOM_MIRROR_ENABLED 1
    open --env 'AGENTDESK_RUNTIME_ROOT={{runtime_root}}' --env 'AGENT_FEED_GRID_ENCODER_PATH={{grid_encoder}}' "{{host_app}}"; sleep 3
    test -n "$(sh tools/exact-executable-pids.sh '{{host_app}}/Contents/MacOS/AgentDeskHost')" || { echo "host did not start"; exit 1; }

    echo "== build + update sim client =="
    just client-sim-install >/dev/null

    echo "== pair + launch sim client with DOM mirror on (console tee) =="
    xcrun simctl bootstatus "$UDID" -b >/dev/null
    rm -f "$PAIRURL" "$CONSOLE"
    HOST_PID="$(sh tools/exact-executable-pids.sh '{{host_app}}/Contents/MacOS/AgentDeskHost' | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running"; exit 1; }
    kill -USR1 "$HOST_PID"
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

# The gate for the current path: the TypeScript panel and sidecar, the JS that builds them, and
# the one native helper that path spawns. Run it after an ordinary change.
#
# It deliberately does NOT compile the Mac host, the iOS client, or the Swift packages behind
# them. That is minutes of compiling for code the working loop does not touch; see FEATURE-MAP.md
# for which parts of the tree are current. When a change reaches native code, run `just
# swift-check` as well -- and note that the auto-commit rule in AGENTS.md means green there too,
# not just here. `just voice-check` covers the dormant voice arc, `just sim-test` the iOS
# simulator suite, and `just check-all` runs the lot.
# Every leg of the current-path gate, run whatever changed. `check` runs only the legs a diff
# can affect; this is the sweep, and what `check-all` builds on.
check-legs: agent-feed-sidecar-check agent-panel-web-check agent-feed-fitness terminal-web-check build-system-check grid-encoder tools-check

# Only the legs the current diff can actually affect.
#
# Measured 2026-10-19: the panel's suite is ~45s and the sidecar's ~15-20s, which is what most of a
# gate is; the typechecks are about a second each. The sidecar's figure is with `bun test --parallel`
# (its package.json), after every sidecar test stopped waiting on the clock (check 10 of the fitness
# gate): run one file at a time with its waits it was ~47s. The lever is still not running suites a
# diff cannot reach. A sidecar-only change runs one leg instead of seven.
#
# Conservative in one direction on purpose: a path no leg claims runs everything, because a
# silently skipped leg is worse than a slow gate. Native paths are reported, never run -- they
# belong to `just swift-check`, and this deliberately does not invoke it.
#
# Each leg runs under a time limit and fails, named, when it outruns it. Measured 2026-10-18: one
# sidecar test run sat at 0% CPU with its sockets open for over nine minutes and would have held
# the gate open for good; the same suite then passed in 47s. Ten minutes is several times any leg.
#
# The sidecar's leg gets two minutes of its own, because its hang does not end by waiting. Sampled
# 2026-10-19: a worker whose main thread and File Watcher thread are parked on one lock runs nothing
# again, timers included, so the ten minutes were nine and a half spent on a run already lost. The
# leg is a typecheck and `bun test --parallel`, ~10-25s; the slowest seen was 42s with every leg of
# the gate running at once on a machine at load 35.
check_leg_timeout := env_var_or_default("AGENTDESK_CHECK_LEG_TIMEOUT", "600")
check_sidecar_leg_timeout := env_var_or_default("AGENTDESK_CHECK_SIDECAR_LEG_TIMEOUT", "120")
check:
    #!/usr/bin/env bash
    set -uo pipefail
    changed="$(git diff --name-only HEAD; git ls-files --others --exclude-standard)"
    if [ -z "$changed" ]; then
        changed="$(git diff --name-only '@{upstream}'...HEAD 2>/dev/null || true)"
        if [ -n "$changed" ]; then
            echo "check: tree is clean, so checking what is committed but unpushed." >&2
        fi
    fi
    if [ -z "$changed" ]; then
        echo "check: nothing changed since HEAD or upstream. Nothing to check." >&2
        echo "check: run 'just check-legs' for the full sweep." >&2
        exit 0
    fi
    legs=""
    native=""
    unclaimed=""
    add() {
        case " $legs " in
            *" $1 "*) ;;
            *) legs="$legs $1" ;;
        esac
    }
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        case "$path" in
            agent-feed/sidecar/*) add agent-feed-sidecar-check ;;
            # The wire is the contract both ends compile against, so it is both their problem.
            agent-feed/wire/*) add agent-feed-sidecar-check; add agent-panel-web-check ;;
            packages/AgentPanel/Web/*) add agent-panel-web-check ;;
            terminal/pty-client-swift/Web/*) add terminal-web-check ;;
            tools/build-system/*|tools/runtime-paths.mjs|Justfile) add build-system-check ;;
            tools/grid-encoder/*|tools/test-desktop-*.sh) add grid-encoder ;;
            # build-system-check owns the tests that drive these two scripts.
            tools/build-grid-encoder.sh|tools/swiftc-cached.sh) add grid-encoder; add build-system-check ;;
            # Fitness runs on every gate, and these two are its own script and the formatter it calls.
            tools/agent-feed-fitness.sh|tools/format.sh) ;;
            # Any other script in `tools/` is tested by its own `-tests.sh`, not by the suites, so an
            # edit there runs those rather than every leg.
            tools/*) add tools-check ;;
            # Compiled into the helper from the host tree, so they are this gate's business too.
            host/AgentDeskHost/SkyLightSymbols.swift|host/AgentDeskHost/DockSwipeEvent.swift)
                add grid-encoder; native="$native $path" ;;
            host/*|client/*|terminal/pty-manager/*|packages/*/Sources/*|packages/*/Tests/*)
                native="$native $path" ;;
            # deskzoom is the virtual display and its RFB client: Swift and Python that no leg
            # in this gate tests. Saying so beats falling through to the run-everything default.
            deskzoom/*) ;;
            *.md|.gitignore|architecture-decisions/*|tasks/*|mock-design/*) ;;
            *) unclaimed="$unclaimed $path" ;;
        esac
    done <<< "$changed"
    if [ -n "$unclaimed" ]; then
        echo "check: no leg claims:$unclaimed" >&2
        echo "check: running every leg rather than guessing." >&2
        legs="agent-feed-sidecar-check agent-panel-web-check terminal-web-check build-system-check grid-encoder tools-check"
    fi
    # Always, because it is two seconds and it reads across the host Swift, the panel Swift and
    # the wire at once: its inputs are too spread to map honestly.
    add agent-feed-fitness
    echo "check:$legs" >&2
    # Each leg in a process group of its own (`set -m`), so a stop reaches everything it started.
    # The watchdog sleeps to the deadline rather than polling: `wait` has no timeout to give it.
    # TERM first, which a leg's own traps turn into reaping its children, then KILL after a grace.
    set -m
    run_leg() {
        local limit='{{check_leg_timeout}}'
        [ "$1" = agent-feed-sidecar-check ] && limit='{{check_sidecar_leg_timeout}}'
        just "$1" &
        local leg=$! began=$SECONDS leg_status=0
        (
            sleep "$limit"
            kill -TERM -- "-$leg" 2>/dev/null
            sleep 5
            kill -KILL -- "-$leg" 2>/dev/null
        ) &
        local watchdog=$!
        # Asked again until the leg is gone: under job control `wait` can return while it still runs,
        # and stopping the watchdog then would cancel the KILL a leg that ignores TERM needs.
        while kill -0 "$leg" 2>/dev/null; do
            wait "$leg"
            leg_status=$?
        done
        kill -- "-$watchdog" 2>/dev/null
        if (( SECONDS - began < limit )); then return "$leg_status"; fi
        echo "check: $1 did not finish in ${limit}s; stopped it and failed the leg" >&2
        # Whatever the leg left in its group goes too, rather than outliving the gate.
        kill -KILL -- "-$leg" 2>/dev/null
        return 124
    }
    status=0
    for leg in $legs; do
        echo "===== $leg" >&2
        run_leg "$leg" || status=1
    done
    if [ -n "$native" ]; then
        echo >&2
        echo "check: native files changed and this gate does not build them:$native" >&2
        echo "check: run 'just swift-check' as well." >&2
    fi
    exit $status

# The native apps and the machinery that launches them: the Swift packages, the Rust PTY manager,
# the whole Xcode host test suite, and the shell tests covering host-run and client-install
# lifecycle, launch env, telemetry summaries and TestFlight upload.
#
# Split out of `just check` because compiling it dominates the wall clock of a gate that most
# changes do not need. Run it when you edit host/, client/, terminal/, packages/*/Sources, or the
# Justfile recipes that launch either app.
swift-check variant="stable": ensure-agent-feed-sidecar-placeholder ensure-pty-runtime-placeholder workspace-ide-fitness tools-check
    #!/usr/bin/env bash
    set -euo pipefail
    (cd packages/AgentDeskWire && swift test)
    (cd packages/KeyboardDictation && swift test)
    (cd packages/BrowserProjection && swift test)
    (cd packages/WorkspaceKit && swift test)
    (cd packages/WorkspaceIDE && swift test)
    (cd terminal/pty-client-swift && swift test)
    (cd '{{pty_manager_dir}}' && cargo test)
    if [ "{{variant}}" = "dev" ]; then
        DD='{{host_dev_derived_data}}'; EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev)
    else
        DD='{{derived_data}}'; EXTRA=()
    fi
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DD" ${EXTRA[@]+"${EXTRA[@]}"} -collect-test-diagnostics never test

# The voice arc's own gates: the phone-model mapping and calibration contracts, the evidence
# summariser, and the gesture-agent Python suite. Dormant since 2026-08-14, and nothing on the
# current path imports any of it, so it is not in `just check`. Run it if voice work resumes.
voice-check:
    #!/usr/bin/env bash
    set -euo pipefail
    /usr/bin/python3 tools/voice-phone-evidence-summary-tests.py
    (cd gesture-agent && uv run python -m unittest discover -s tests)
    /usr/bin/python3 tools/generate-voice-phone-mapping.py --check
    /usr/bin/python3 tools/voice-phone-calibration-contract-check.py

# Real coordinator-to-pty-manager lifecycle smoke on an isolated temporary socket.
# This builds the test daemon in place and never launches either app.
agent-terminal-integration-test:
    #!/usr/bin/env bash
    set -euo pipefail
    (cd '{{pty_manager_dir}}' && cargo build --bin pty-manager --bin pty-vault)
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost \
        -derivedDataPath '{{derived_data}}' test \
        -only-testing:AgentDeskHostTests/AgentSessionTerminalIntegrationTests

# AgentDeskWire package unit tests: the shared wire contract's authoritative
# round-trip suite (ADR-0050). Also run as a leg of `swift-check`.
wire-test:
    cd packages/AgentDeskWire && swift test

# Client simulator tests. Boots the iPhone simulator and is the slowest leg of all, split out of
# both `check` and `swift-check`. Run before committing client-side changes.
#
# Builds into {{sim_test_derived_data}}, not the shared tree, so it can run concurrently with a
# device or host build instead of losing a race for build.db. The cost is one cold build the
# first time and a second copy on disk; the benefit is that the gate is always runnable.
#
# Deliberately NOT routed through tools/xcodebuild-quiet.sh: that wrapper hides stdout on
# success, and on a test run stdout is the result. "Test run with N tests passed" is the whole
# point of running this.
sim-test: ensure-webview-placeholder voice-assets-stage-tests
    xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -derivedDataPath '{{sim_test_derived_data}}' -sdk iphonesimulator -destination '{{ios_test_destination}}' build test

# Everything: the current-path gate, the native apps, the voice arc, and the client simulator
# tests. Minutes, not seconds.
check-all: check-legs swift-check voice-check sim-test

# Reproduce the pinned R130 Core ML phone model and stage its coupled manifest
# and vocabulary under the client synchronized resource root. The large source
# and generated package stay in .build / gitignored client resources.
voice-phone-model:
    #!/usr/bin/env bash
    set -euo pipefail
    VENV='{{justfile_directory()}}/.build/voice-phone-model/venv'
    if [ ! -x "$VENV/bin/python" ]; then
        uv venv --python 3.12 "$VENV"
    fi
    uv pip install --python "$VENV/bin/python" \
        'coremltools==9.0' \
        'scikit-learn==1.5.1'
    "$VENV/bin/python" tools/prepare-voice-phone-model.py

voice-phone-model-check:
    #!/usr/bin/env bash
    set -euo pipefail
    /usr/bin/python3 tools/prepare-voice-phone-model.py --check-only || {
        echo "R130 phone model is missing or stale; run: just voice-phone-model"
        exit 1
    }

# Stage the pinned 70.7 MB ZIPA INT8 ONNX graph, its ID-ordered token source,
# model manifest, and upstream MIT license under the synchronized client
# resource root. All inputs are immutable-revision and SHA-256 pinned.
voice-zipa-model:
    /usr/bin/python3 tools/prepare-voice-zipa-model.py

voice-zipa-model-check:
    #!/usr/bin/env bash
    set -euo pipefail
    /usr/bin/python3 tools/prepare-voice-zipa-model.py --check-only || {
        echo "R140 ZIPA model is missing or stale; run: just voice-zipa-model"
        exit 1
    }

# Copy the exact set the phone reads at runtime into `target`, and nothing else.
# The .mlpackage is a build intermediate that the Mac compiles away here, and the
# phone map is compiled into Swift rather than read, so neither is published.
voice-assets-publish target: voice-phone-model-check voice-zipa-model-check
    #!/usr/bin/env bash
    set -euo pipefail
    OUT='{{target}}'
    STAGED='{{voice_assets_staged}}'
    SHARED='{{voice_assets_src}}'
    mkdir -p "$OUT"
    # The consumer gets the COMPILED model. Compiling a 152 MB Core ML package on
    # an iPhone is the one step that would make first use of the Voice surface
    # feel broken; the Mac does it in under a second, so it does it once here.
    rm -rf "$OUT/VoicePhoneModel.mlmodelc"
    "$(xcrun --find coremlcompiler)" compile "$STAGED/VoicePhoneModel.mlpackage" "$OUT"
    for NAME in VoicePhoneModelManifest.json VoicePhoneVocabulary.json \
                VoiceZIPAModel.onnx VoiceZIPAModelManifest.json \
                VoiceZIPATokens.txt VoiceZIPALicense.txt; do
        cp -f "$STAGED/$NAME" "$OUT/$NAME"
    done
    for NAME in VoiceCMUDictionary.txt VoiceCMUDictionaryLicense.txt; do
        cp -f "$SHARED/$NAME" "$OUT/$NAME"
    done
    echo "voice-assets-publish: $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1) -> $OUT"

# Publish the voice models to this Mac so the host can serve them to a paired
# phone, and so the host's own Python sidecar can read the ZIPA graph. One-time
# machine setup, not a build step: no app build depends on it, and re-running it
# is idempotent.
voice-assets-install: (voice-assets-publish voice_assets_root)

# The same set, staged into the client test resource root. The models are not in
# the app any more, so without this the tests that run real inference and assert
# exact phone sequences would quietly become tests of a missing-asset error.
# Gitignored, and paid only by `just sim-test`, never by a client build.
voice-assets-stage-tests: (voice-assets-publish (justfile_directory() + "/client/AgentDeskClientTests"))

# One authoritative CMUdict-to-model-phone mapping feeds the iPhone and the
# offline calibration harness.
voice-phone-mapping:
    /usr/bin/python3 tools/generate-voice-phone-mapping.py

voice-phone-mapping-check:
    /usr/bin/python3 tools/generate-voice-phone-mapping.py --check

# File-level import-only clustering on top of graphify's graph.json --
# graphify itself clusters on every edge type at once (calls, implements,
# inherits, ...), which lets a protocol like Equatable bridge hundreds of
# unrelated files into one community. This restricts clustering to
# imports/imports_from/re_exports/dynamic_import edges only, so communities
# reflect actual module dependency, not shared conformance to something like
# Equatable/Codable. Requires graphify-out/graph.json (`graphify update .`
# or `graphify cluster-only .` first). Installs networkx into an ephemeral
# uv env rather than depending on graphify's own tool install layout.
graphify-import-graph:
    uv run --with networkx --no-project python3 tools/graphify-import-graph.py \
        graphify-out/graph.json graphify-out/IMPORT_GRAPH.html {{justfile_directory()}}

# The large labeled corpora and derived rows stay under .build. SpeechOcean is
# downloaded and hash-verified automatically. L2-ARCTIC requires the user to
# accept its CC BY-NC terms and supply a local root before infer-l2 can run.
voice-phone-calibration-env:
    #!/usr/bin/env bash
    set -euo pipefail
    VENV='{{justfile_directory()}}/.build/voice-phone-model/venv'
    if [ ! -x "$VENV/bin/python" ]; then
        uv venv --python 3.12 "$VENV"
    fi
    uv pip install --python "$VENV/bin/python" \
        -r tools/voice-phone-calibration-requirements.txt

voice-phone-calibration-test: voice-phone-calibration-env voice-phone-mapping-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration-tests.py

voice-phone-calibration-audit: voice-phone-calibration-env voice-phone-mapping-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py audit

voice-phone-calibration-smoke limit="2": voice-phone-calibration-env voice-phone-mapping-check voice-phone-model-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py smoke --limit '{{limit}}'

voice-phone-calibration-train: voice-phone-calibration-env voice-phone-mapping-check voice-phone-model-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py infer-train

voice-phone-calibration-test-split: voice-phone-calibration-env voice-phone-mapping-check voice-phone-model-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py infer-test

voice-phone-calibration-l2 l2_root: voice-phone-calibration-env voice-phone-mapping-check voice-phone-model-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py infer-l2 --l2-root '{{l2_root}}'

voice-phone-calibration-report: voice-phone-calibration-env voice-phone-mapping-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py report

voice-phone-calibration: voice-phone-calibration-env voice-phone-mapping-check voice-phone-model-check
    .build/voice-phone-model/venv/bin/python \
        tools/voice-phone-calibration.py run

# The candidate scorer benchmark is intentionally isolated from the shipping
# calibration environment. It validates a pinned public checkpoint on its
# official upstream features, and never enables the in-app grade.
voice-pronunciation-model-benchmark-env:
    #!/usr/bin/env bash
    set -euo pipefail
    VENV='{{justfile_directory()}}/.build/voice-pronunciation-model-benchmark/venv'
    if [ ! -x "$VENV/bin/python" ]; then
        uv venv --python 3.12 "$VENV"
    fi
    uv pip install --python "$VENV/bin/python" \
        -r tools/voice-pronunciation-model-benchmark-requirements.txt

voice-pronunciation-model-benchmark-test: voice-pronunciation-model-benchmark-env
    .build/voice-pronunciation-model-benchmark/venv/bin/python \
        tools/voice-pronunciation-model-benchmark-tests.py

voice-pronunciation-model-benchmark: voice-pronunciation-model-benchmark-env
    .build/voice-pronunciation-model-benchmark/venv/bin/python \
        tools/voice-pronunciation-model-benchmark.py

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
# AGENTDESK_OWNED_MEDIA_* is forwarded for one-shot owned media feel runs
# with `just fresh-install`. The retained-tile repair knobs are documented
# as AGENTDESK_HYBRID_* in .env.example.
# host-run-dev is the Debug (-Onone) twin of host-run, for fast, breakpoint-friendly iteration
# (host-run is the Release primary). The `variant` arg is an independent axis: the .dev bundle.
# variant: "stable" (default) or "dev" (the experimental side-by-side host:
# bundle id {{host_dev_bundle_id}}, DEV-badged icon, separate derived-data dir,
# tier-derived ports). The dev host runs concurrently with the stable one.
prepare-pty-runtime variant="stable": build-pty-runtime
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then
        SUPPORT='{{host_dev_support_dir}}'
    else
        SUPPORT='{{host_support_dir}}'
    fi
    MANAGER_SOCKET="$SUPPORT/pty-manager.sock"
    VAULT_SOCKET="$SUPPORT/pty-vault.sock"
    # One-time clean cutover from the pre-vault architecture. Once a live vault
    # exists, no runtime recipe terminates a PTY process; updates use
    # candidate handover and failures leave the old generation authoritative.
    VAULT_PIDS="$(
        ps -axo pid=,command= |
            awk -v socket="$VAULT_SOCKET" \
                'index($0, "pty-vault --socket") && index($0, socket) { print $1 }'
    )"
    if [ -z "$VAULT_PIDS" ] && [ ! -S "$MANAGER_SOCKET.handover" ]; then
        LEGACY_PIDS="$(
            ps -axo pid=,command= |
                awk -v socket="$MANAGER_SOCKET" \
                    'index($0, "pty-manager --socket") && index($0, socket) { print $1 }'
        )"
        if [ -n "$LEGACY_PIDS" ]; then
            echo "one-time pre-vault PTY cutover for {{variant}}; existing sessions will restart"
            kill $LEGACY_PIDS 2>/dev/null || true
            for _ in $(seq 1 40); do
                LIVE="$(ps -p $LEGACY_PIDS -o pid= 2>/dev/null || true)"
                [ -z "$LIVE" ] && break
                sleep 0.05
            done
            LIVE="$(ps -p $LEGACY_PIDS -o pid= 2>/dev/null || true)"
            [ -z "$LIVE" ] || kill -9 $LIVE 2>/dev/null || true
            rm -f "$MANAGER_SOCKET" "$MANAGER_SOCKET.handover" \
                "$MANAGER_SOCKET.identity" "$VAULT_SOCKET" "$VAULT_SOCKET.identity"
        fi
    fi

# Attach a debugger to the NEXT host launch, so a crash stops at the faulting frame instead of
# vanishing.
#
# Reach for this when a crash needs a stack rather than a message. Three layers exist and they
# catch different things:
#   1. os_log (`just host-logs`) carries what the host chose to log, and nothing about a crash.
#   2. Host stderr ({{host_stdio}}, kept by host-run) carries a Swift trap's own message, the
#      "Fatal error: Index out of range" line and its file and line. Usually enough.
#   3. This, for the stack that produced it, or for a crash that prints nothing at all.
#
# A .ips crash report is deliberately not on that list. Every crash report AgentDeskHost has ever
# written on this machine is a code-signing SIGKILL from a stale signature; not one is an
# application fault, so it is not a channel to rely on.
#
# Run this FIRST in its own terminal, it waits. Then `just host-run` in another. At the trap:
# `bt` for the faulting thread, `bt all` for every thread, `continue` to let it proceed.
# Works against the Release daily driver because development signing carries get-task-allow.
host-debug:
    lldb --wait-for --attach-name AgentDeskHost

# Install the desktop helper for a login session, without rebuilding or relaunching either app.
#
# `path` exists because the agent session's sidecar does not read its helper from that account's
# runtime root. It sets AGENT_FEED_GRID_ENCODER_PATH to a shared location, so the console user can
# update the helper for a session whose ~/Library it cannot even read. Installing to the account's
# own root instead leaves the running helper untouched and the change looks like it did nothing --
# which it did, to a file nobody executes.
#
#   just grid-encoder-install                          # this account's runtime root
#   just grid-encoder-install /Users/Shared/grid-encoder  # the agent session's helper
#
# The other direction now works too: `tools/install-node.sh` gives an account the node this script
# needs, so that session can run the plain form itself.
grid-encoder-install path="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n '{{path}}' ]; then
        AGENT_FEED_GRID_ENCODER_PATH='{{path}}' sh tools/install-grid-encoder.sh
    else
        sh tools/install-grid-encoder.sh
    fi

# An agent-feed sidecar on ANOTHER machine, so the panel's Feed can read that machine's transcripts
# through the session picker it already has. The peer is an ssh host alias; its sidecar binds the
# peer's own tailnet address, which is asked for on the peer rather than written down here.
#
# `setup` once per peer (tmux + bun), then `run` once to start it, then leave `watch` running:
# `run` relaunches and `watch` only ships, which is all the peer's `bun --watch` needs. Declare the
# result to the panel with AGENTDESK_PANEL_REMOTE_SIDECARS in .env -- `run` prints the line.
remote-sidecar-setup peer port="7682":
    bash tools/remote-sidecar.sh setup '{{peer}}' '{{port}}'

remote-sidecar-run peer port="7682":
    bash tools/remote-sidecar.sh run '{{peer}}' '{{port}}'

# The peer's sidecar runs under `bun --watch`, so it reloads about four seconds after its files
# change -- but they only change when somebody ships. This ships on every save, and relaunches the
# peer's sidecar whenever it stops answering, for as long as it runs. One peer, in the foreground;
# `watch-all` is the one that runs at login.
remote-sidecar-watch peer port="7682":
    bash tools/remote-sidecar.sh watch '{{peer}}' '{{port}}'

# Every peer declared in .env, watched at once.
#
# The peer list is read from AGENTDESK_PANEL_REMOTE_SIDECARS rather than written down again here,
# because that is the string the panel itself resolves peers from (`parseDeclaredPeers`). Declaring
# a peer twice is how one of the two ends up pointing somewhere the other does not.
#
# Exits as soon as any watcher does, so the LaunchAgent's KeepAlive brings all of them back
# together. A partial set is the state nobody would notice: the peer whose watcher died goes on
# serving, and goes on serving whatever it had.
remote-sidecar-watch-all:
    #!/usr/bin/env bash
    set -uo pipefail
    # Idling rather than exiting, in both of the nothing-to-do cases below. This runs under
    # KeepAlive, so a job that exits is a job launchd respawns every ten seconds forever, and the
    # log fills with the same line for as long as no peer is declared. Adding the first peer to
    # .env takes effect at the next login, or now with:
    #   launchctl kickstart -k "gui/$(id -u)/{{host_bundle_id}}.remotesidecars"
    idle() {
        echo "remote-sidecar-watch-all: $1; idling"
        while :; do sleep 3600; done
    }
    SPEC="${AGENTDESK_PANEL_REMOTE_SIDECARS:-}"
    [ -n "$SPEC" ] || idle "no AGENTDESK_PANEL_REMOTE_SIDECARS in .env"
    PIDS=""
    # `id=host:port`, comma separated, exactly as the panel parses it. The host is deliberately
    # ignored: the watcher asks the peer for its own tailnet address, which is the one thing that
    # can have changed since this line was written.
    IFS=, read -ra ENTRIES <<< "$SPEC"
    for ENTRY in "${ENTRIES[@]}"; do
        ENTRY="$(echo "$ENTRY" | tr -d '[:space:]')"
        [ -n "$ENTRY" ] || continue
        PEER="${ENTRY%%=*}"
        ADDRESS="${ENTRY#*=}"
        PORT="${ADDRESS##*:}"
        if [ -z "$PEER" ] || [ "$PEER" = "$ENTRY" ] || [ -z "$PORT" ] || [ "$PORT" = "$ADDRESS" ]; then
            echo "remote-sidecar-watch-all: skipping malformed peer '$ENTRY'"
            continue
        fi
        echo "remote-sidecar-watch-all: watching $PEER on port $PORT"
        # Prefixed by a read loop rather than by `sed`, which buffers when its output is not a
        # terminal -- and under launchd it never is. Measured: the watcher had shipped and was
        # back in its poll loop while the log still ended at the line before, because ~4KB of it
        # was sitting in sed's buffer. A supervised job whose log arrives in blocks cannot answer
        # "did it ship", which is the only question anyone opens this log to ask.
        bash tools/remote-sidecar.sh watch "$PEER" "$PORT" 2>&1 \
            | while IFS= read -r LINE; do printf '[%s] %s\n' "$PEER" "$LINE"; done &
        PIDS="$PIDS $!"
    done
    [ -n "$PIDS" ] || idle "no usable peers in AGENTDESK_PANEL_REMOTE_SIDECARS"
    trap 'kill $PIDS 2>/dev/null || true' EXIT INT TERM
    # `wait -n` is bash 4; this Mac's /bin/bash is 3.2, and the shebang above may resolve to it.
    # Polling the pids costs one signal-0 per peer every five seconds and works on both.
    while :; do
        sleep 5
        for PID in $PIDS; do
            kill -0 "$PID" 2>/dev/null && continue
            echo "remote-sidecar-watch-all: a watcher exited; stopping so the job restarts all of them"
            exit 1
        done
    done

remote-sidecar-stop peer port="7682":
    bash tools/remote-sidecar.sh stop '{{peer}}' '{{port}}'

# Answers the question that matters: is it reachable FROM THIS MAC, not merely running over there.
# It does NOT answer whether the peer is running the CURRENT code: `bun --watch` keeps the port
# bound across a reload, so a two-day-old tree answers this exactly as a fresh one does.
remote-sidecar-status peer port="7682":
    bash tools/remote-sidecar.sh status '{{peer}}' '{{port}}'

# The relay that lets a peer's sidecar reach this Mac's proxy-agent observer API, in the
# foreground. `proxy-observer-relay-login.sh` is this same recipe as a supervised job, so there is
# one definition of what the relay is rather than two that drift.
#
# Foreground on purpose, like `agent-webview-dev`: launchd supervises the process it starts, so the
# thing it starts has to be the server itself.
proxy-observer-relay:
    bun tools/proxy-observer-relay.mjs

# Who is watching a sidecar's displays and which grid-encoders are capturing for them. One login
# session per sidecar; the registry entry names its port.
webrtc-sessions user=env_var_or_default("USER", "dev"):
    curl -sf "http://127.0.0.1:$(jq -r .port /Users/Shared/agentdesk/sidecars/{{user}}.json)/api/park/webrtc/sessions" | jq .

# End viewers and captures: everything by default, one viewer with `attempt=<id>`, one capture
# with `pid=<pid>` (ids and pids from `just webrtc-sessions`). A viewer whose peer is closed
# reconnects on its own; this is for a stuck stream, not a logout.
webrtc-close user=env_var_or_default("USER", "dev") attempt="" pid="":
    #!/usr/bin/env bash
    set -euo pipefail
    PORT=$(jq -r .port /Users/Shared/agentdesk/sidecars/{{user}}.json)
    if [ -n "{{attempt}}" ]; then BODY='{"attempt":"{{attempt}}"}'
    elif [ -n "{{pid}}" ]; then BODY='{"encoderPid":{{pid}}}'
    else BODY='{"all":true}'; fi
    curl -sf -X POST -H 'content-type: application/json' -d "$BODY" "http://127.0.0.1:$PORT/api/park/webrtc/sessions/close" | jq .

host-run-dev variant="stable" install_live_bridge="true" panel="live" sidecar="live": build-agent-feed-sidecar build-agent-webview build-gesture-webview build-voice-sidecar
    #!/usr/bin/env bash
    set -euo pipefail
    # Like host-run, this builds the real bundled artifacts (agent sidecar + webview,
    # gesture/voice webview + voice-server source) first, so a dev launch always
    # reflects the latest code. DOM mirror (Chrome page mirroring, ADR-0038) is baked on by default for every
    # variant now, so no AGENTDESK_DOM_MIRROR_ENABLED override is injected here; the
    # host's own code default carries it (single source of truth). The native-messaging
    # bridge is wired at the end of this recipe so browser mode works out of the box.
    if [ "{{variant}}" = "dev" ]; then
        DD='{{host_dev_derived_data}}'; BUILT_APP='{{host_dev_build_app}}'; APP='{{host_dev_app}}'; HOST_BID='{{host_dev_bundle_id}}'; SIGPORT=41988; FEEDPORT=7782; VOICEPORT=7792; VOICEBACKENDPORT=7793
        PTY_SOCKET='{{host_dev_pty_manager_socket_path}}'
        PTY_VAULT_SOCKET='{{host_dev_support_dir}}/pty-vault.sock'
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev)
    else
        DD='{{derived_data}}'; BUILT_APP='{{host_build_app}}'; APP='{{host_app}}'; HOST_BID='{{host_bundle_id}}'; SIGPORT=41888; FEEDPORT=7682; VOICEPORT=7692; VOICEBACKENDPORT=7693
        PTY_SOCKET='{{host_pty_manager_socket_path}}'
        PTY_VAULT_SOCKET='{{host_support_dir}}/pty-vault.sock'
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_bundle_id}}')
    fi
    # Resolved here, above every reader, because the panel block below now needs the effective
    # value too: it tells the dev server which sidecar to proxy a browser tab to, and a tier
    # default that ignored the override would point that tab at the wrong host's feed.
    FEEDPORT="${AGENTDESK_AGENT_FEED_PORT:-$FEEDPORT}"
    VOICEPORT="${AGENTDESK_VOICE_SIDECAR_PORT:-$VOICEPORT}"
    VOICEBACKENDPORT="${AGENTDESK_VOICE_SIDECAR_BACKEND_PORT:-$VOICEBACKENDPORT}"
    export AGENT_FEED_PTY_MANAGER_SOCKET="$PTY_SOCKET"
    export AGENTDESK_RUNTIME_ROOT='{{runtime_root}}'
    export AGENT_FEED_GRID_ENCODER_PATH='{{grid_encoder}}'
    if [ "${AGENTDESK_AX_AUTOMATION_ENABLED:-0}" != "0" ]; then
        EXTRA+=(INFOPLIST_KEY_LSUIElement=NO)
    fi
    find_pty_manager_pids() {
        ps -axo pid=,command= | awk -v manager="$PTY_SOCKET" -v vault="$PTY_VAULT_SOCKET" \
            '(index($0, "pty-manager --socket") && index($0, manager)) || (index($0, "pty-vault --socket") && index($0, vault)) { print $1 }'
    }
    # Do not let an older running host execute its old applicationWillTerminate
    # hook, because pre-ADR-0072 hosts killed their PTY child processes.
    kill_host_pids() {
        local pid child children preserve
        preserve="$(find_pty_manager_pids | tr '\n' ' ')"
        for pid in "$@"; do
            children="$(pgrep -P "$pid" 2>/dev/null || true)"
            kill -9 "$pid" 2>/dev/null || true
            for child in $children; do
                case " $preserve " in
                    *" $child "*) ;;
                    *) kill "$child" 2>/dev/null || true ;;
                esac
            done
        done
    }
    # The panel is served live by DEFAULT: Vite comes up before anything is torn down, and the
    # launched host loads its panel from there, so a TSX edit lands in the running host with no
    # rebuild and no relaunch. This is also the ONLY place the choice is made for the phone: the
    # host states this origin to every client that attaches, so `panel=bundled` opts both surfaces
    # out and is what a run judging the SHIPPED webview wants. An origin already in the environment
    # is left alone: an operator pointing at their own server means it.
    case '{{panel}}' in
        live|bundled) ;;
        *) echo "ERROR: panel must be 'live' or 'bundled', got '{{panel}}'" >&2; exit 64 ;;
    esac
    if [ '{{panel}}' = live ] && [ -z "$(printenv '{{agent_panel_origin_var}}' || true)" ]; then
        # Assigned on its own line before being exported, because `export VAR="$(cmd)"` swallows a
        # non-zero substitution status even under `set -e`: a dev server that failed to come up
        # would launch the host with an EMPTY origin, which is the bundled panel wearing the live
        # one's name -- the exact silent fallback this default is supposed to make impossible.
        PANEL_ORIGIN="$(just agent-webview-dev-ensure '{{agent_panel_dev_port}}' "http://127.0.0.1:$FEEDPORT")"
        # Checked rather than trusted, because that value travels by stdout: anything else in the
        # recipe that prints lands in it, and the host answers a malformed origin by refusing to
        # build its panel at all -- on the Mac AND on every attached phone. Caught here it is one
        # failed launch naming the culprit.
        case "$PANEL_ORIGIN" in
            https://*) ;;
            *) echo "ERROR: agent-webview-dev-ensure printed more than an origin: $PANEL_ORIGIN" >&2; exit 1 ;;
        esac
        export {{agent_panel_origin_var}}="$PANEL_ORIGIN"
    fi
    # The sidecar, same live-or-frozen axis as the panel and for the same reason. `bundled` runs
    # the compiled binary the app ships with, so a one-line change to the sidecar costs a rebuild,
    # a relaunch, and a re-attach of every surface; `live` runs the supervisor over the source
    # (agent-feed/sidecar/src/supervisor.ts), which owns the server as a child and replaces it when
    # the tree typechecks, so an edit is live seconds later with the host and every attached phone
    # left alone. It replaced `bun --watch`, which re-read on every write: a file saved halfway
    # through an edit threw during the reload and left the process alive with its port free, so
    # every stream the panel holds died at once and nothing noticed for a minute.
    #
    # `live` is the default, the same as the panel, so the two halves of the panel surface behave
    # alike: an edit anywhere in it is live without a relaunch. The cost is real and is accepted --
    # this arm executes the WORKING TREE, so a half-saved file is what runs, and a run that must
    # judge the artifact as it ships has to say so. Arguments are POSITIONAL in just, so that is
    # `just host-run stable live bundled`, not `sidecar=bundled` (which would land in `variant`).
    case '{{sidecar}}' in
        live|bundled) ;;
        *) echo "ERROR: sidecar must be 'live' or 'bundled', got '{{sidecar}}'" >&2; exit 64 ;;
    esac
    if [ '{{sidecar}}' = live ]; then
        # Resolved to an absolute path here rather than searched for in the host, whose child
        # environment is deliberately stripped of the PATH that would find a Homebrew install.
        BUN_PATH="$(command -v bun || true)"
        if [ -z "$BUN_PATH" ]; then
            echo "ERROR: sidecar=live needs bun on PATH" >&2
            exit 1
        fi
        export AGENTDESK_BUN_PATH="$BUN_PATH"
        export AGENTDESK_AGENT_FEED_SIDECAR_ENTRY='{{agent_feed_sidecar_dir}}/src/supervisor.ts'
        # Its dependencies are resolved from the source tree now, not baked into a binary, so the
        # tree has to have them. Without this the host spawns bun, bun cannot resolve an import,
        # and the failure arrives as a sidecar that never answers readiness.
        node '{{justfile_directory()}}/tools/build-system/ensure-js-dependencies.mjs' \
          agent-feed-sidecar '{{agent_feed_sidecar_dir}}' '{{justfile_directory()}}/.build/js-dependencies'
    fi
    just prepare-pty-runtime "{{variant}}"
    sh tools/xcodebuild-quiet.sh -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath "$DD" MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" ${EXTRA[@]+"${EXTRA[@]}"} build
    node tools/build-system/install-runtime.mjs verify-host "$BUILT_APP" "$HOST_BID"
    just grid-encoder-install
    # Debug/Release share one durable install per bundle id. Exact matching cannot
    # select the sibling host, bundled sidecars, or surviving PTY processes.
    HOST_PIDS="$(sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost")"
    [ -n "$HOST_PIDS" ] && kill_host_pids $HOST_PIDS
    # Backstop for a separately configured runtime root holding this tier's port.
    # The installed path above is otherwise shared across source checkouts.
    # Scoped to the tier-derived port (env override honored, matching Config), so
    # the sibling variant on its own port is never touched.
    SIGPORT="${AGENTDESK_SIGNALING_PORT:-$SIGPORT}"
    UDP_PORT_RECORDS="$(lsof -nP -iUDP:"$SIGPORT" -F pn 2>/dev/null || true)"
    PORT_PIDS="$(
        {
            lsof -nP -iTCP:"$SIGPORT" -sTCP:LISTEN -t 2>/dev/null || true
            printf '%s\n' "$UDP_PORT_RECORDS" |
                sh tools/local-udp-port-pids.sh "$SIGPORT"
        } | sort -u
    )"
    # A stranger on this port is still in our way, so it is reclaimed too, not
    # reported. Only a host goes through kill_host_pids, whose child sweep is
    # written for a host's process tree and would be over-broad for anyone else.
    if [ -n "$PORT_PIDS" ]; then
        HOST_PORT_PIDS=()
        STRANGER_PORT_PIDS=()
        for PID in $PORT_PIDS; do
            CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
            if [[ "$CMD" == *"/AgentDeskHost.app/Contents/MacOS/AgentDeskHost"* ]]; then
                HOST_PORT_PIDS+=("$PID")
            else
                echo "reclaiming signaling port $SIGPORT from pid=$PID cmd=${CMD:-<already exited>}" >&2
                STRANGER_PORT_PIDS+=("$PID")
            fi
        done
        [ "${#HOST_PORT_PIDS[@]}" -gt 0 ] && kill_host_pids "${HOST_PORT_PIDS[@]}"
        [ "${#STRANGER_PORT_PIDS[@]}" -gt 0 ] && kill -9 "${STRANGER_PORT_PIDS[@]}" 2>/dev/null || true
    fi
    sh tools/reclaim-port.sh "agent-feed sidecar" "$FEEDPORT"
    sh tools/reclaim-port.sh "voice sidecar" "$VOICEPORT"
    sh tools/reclaim-port.sh "voice server" "$VOICEBACKENDPORT"
    sleep 1
    node tools/build-system/install-runtime.mjs host "$BUILT_APP" "$APP" "$HOST_BID"
    trap 'env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_ITERATION_RUN=1 tools/launch-env.sh unset' EXIT
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_ITERATION_RUN=1 tools/launch-env.sh set
    # Capture the host's stdio. Without this a Swift trap message is discarded and a crash leaves
    # nothing behind but a timestamp, which is exactly what happened to the close-all-sessions crash.
    # Roll the outgoing launch aside rather than truncating it: the relaunch after a crash is the
    # moment its output matters most. Only the tail survives, which is where a trap prints.
    if [ -s '{{host_stdio}}' ]; then
        tail -c '{{host_stdio_keep_bytes}}' '{{host_stdio}}' > '{{host_stdio}}.prev' 2>/dev/null || true
    fi
    : > '{{host_stdio}}'
    if [ "${AGENTDESK_AX_AUTOMATION_PRESERVE_FOCUS:-0}" != "0" ]; then
        open -g --stdout '{{host_stdio}}' --stderr '{{host_stdio}}' "$APP"
    else
        open --stdout '{{host_stdio}}' --stderr '{{host_stdio}}' "$APP"
    fi
    HOST_PID=""
    for _ in $(seq 1 50); do
        HOST_PID="$(sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost" | head -1)"
        [ -n "$HOST_PID" ] && break
        sleep 0.1
    done
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_ITERATION_RUN=1 tools/launch-env.sh unset
    trap - EXIT
    test -n "$HOST_PID" || {
        echo "ERROR: newly built host did not launch: $APP" >&2
        exit 1
    }
    echo "$HOST_PID $APP/Contents/MacOS/AgentDeskHost"
    # DOM bridge is first-class: wire this variant's native-messaging manifest on every
    # launch so the Chrome extension can reach the running host. Non-fatal so a host run
    # never blocks on Chrome/node config; it warns loudly instead of failing silently.
    if [ "{{install_live_bridge}}" = "true" ]; then
        just dom-bridge-reinstall {{variant}} || echo "WARN: dom-bridge wiring failed; browser mode will not mirror until 'just dom-bridge-reinstall {{variant}}' succeeds"
    else
        echo "host-run-dev: skipped personal Chrome bridge install"
    fi

# host-run is the PRIMARY host launch: -configuration Release, so the host runs at shipped-build
# performance. A Debug (-Onone) host pegs a core in the crisp tile codec (OwnedTileCodec.extractTileWithHash
# per-byte Range loops); Release optimizes that away (~100% -> ~30% CPU). For fast, breakpoint-friendly
# iteration use the Debug twin host-run-dev; both share the same kill + rebuild + relaunch lifecycle.
# Builds the real bundled artifacts first (agent sidecar + agent webview, and the
# gesture/voice webview + voice-server source), so every launch reflects the latest
# code instead of stale staged binaries. Composites therefore no longer pre-build
# these before calling host-run.
#
# `panel` (live | bundled) selects where the Agent Panel's code comes from. Live is the default and
# starts the Vite dev server if it is not already up, so a TSX edit changes the running host with
# no rebuild. Choose bundled to judge the webview as it actually ships.
# Plain `just host-run` prepares the live panel and agent sidecar, PTY runtime, standalone
# desktop helper, and provisioned voice inputs, then installs/launches the durable host app.
host-run variant="stable" panel="live" sidecar="live": build-agent-feed-sidecar build-agent-webview build-gesture-webview build-voice-sidecar
    #!/usr/bin/env bash
    set -euo pipefail
    # DOM mirror is baked on by default (see host-run-dev); no enable override injected here.
    if [ "{{variant}}" = "dev" ]; then
        DD='{{host_dev_derived_data}}'; BUILT_APP='{{host_dev_build_app_release}}'; APP='{{host_dev_app}}'; HOST_BID='{{host_dev_bundle_id}}'; SIGPORT=41988; FEEDPORT=7782; VOICEPORT=7792; VOICEBACKENDPORT=7793
        PTY_SOCKET='{{host_dev_pty_manager_socket_path}}'
        PTY_VAULT_SOCKET='{{host_dev_support_dir}}/pty-vault.sock'
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev)
    else
        DD='{{derived_data}}'; BUILT_APP='{{host_build_app_release}}'; APP='{{host_app}}'; HOST_BID='{{host_bundle_id}}'; SIGPORT=41888; FEEDPORT=7682; VOICEPORT=7692; VOICEBACKENDPORT=7693
        PTY_SOCKET='{{host_pty_manager_socket_path}}'
        PTY_VAULT_SOCKET='{{host_support_dir}}/pty-vault.sock'
        EXTRA=(PRODUCT_BUNDLE_IDENTIFIER='{{host_bundle_id}}')
    fi
    # Resolved here, above every reader, because the panel block below now needs the effective
    # value too: it tells the dev server which sidecar to proxy a browser tab to, and a tier
    # default that ignored the override would point that tab at the wrong host's feed.
    FEEDPORT="${AGENTDESK_AGENT_FEED_PORT:-$FEEDPORT}"
    VOICEPORT="${AGENTDESK_VOICE_SIDECAR_PORT:-$VOICEPORT}"
    VOICEBACKENDPORT="${AGENTDESK_VOICE_SIDECAR_BACKEND_PORT:-$VOICEBACKENDPORT}"
    export AGENT_FEED_PTY_MANAGER_SOCKET="$PTY_SOCKET"
    export AGENTDESK_RUNTIME_ROOT='{{runtime_root}}'
    export AGENT_FEED_GRID_ENCODER_PATH='{{grid_encoder}}'
    if [ "${AGENTDESK_AX_AUTOMATION_ENABLED:-0}" != "0" ]; then
        EXTRA+=(INFOPLIST_KEY_LSUIElement=NO)
    fi
    find_pty_manager_pids() {
        ps -axo pid=,command= | awk -v manager="$PTY_SOCKET" -v vault="$PTY_VAULT_SOCKET" \
            '(index($0, "pty-manager --socket") && index($0, manager)) || (index($0, "pty-vault --socket") && index($0, vault)) { print $1 }'
    }
    # Do not let an older running host execute its old applicationWillTerminate
    # hook, because pre-ADR-0072 hosts killed their PTY child processes.
    kill_host_pids() {
        local pid child children preserve
        preserve="$(find_pty_manager_pids | tr '\n' ' ')"
        for pid in "$@"; do
            children="$(pgrep -P "$pid" 2>/dev/null || true)"
            kill -9 "$pid" 2>/dev/null || true
            for child in $children; do
                case " $preserve " in
                    *" $child "*) ;;
                    *) kill "$child" 2>/dev/null || true ;;
                esac
            done
        done
    }
    # Live panel by default, same as host-run-dev; see the note there. Release changes nothing about
    # this: the Vite origin decides where the panel's code comes from, the build configuration
    # decides how fast the host's own Swift runs, and they are independent axes.
    case '{{panel}}' in
        live|bundled) ;;
        *) echo "ERROR: panel must be 'live' or 'bundled', got '{{panel}}'" >&2; exit 64 ;;
    esac
    if [ '{{panel}}' = live ] && [ -z "$(printenv '{{agent_panel_origin_var}}' || true)" ]; then
        # Assigned on its own line before being exported, because `export VAR="$(cmd)"` swallows a
        # non-zero substitution status even under `set -e`: a dev server that failed to come up
        # would launch the host with an EMPTY origin, which is the bundled panel wearing the live
        # one's name -- the exact silent fallback this default is supposed to make impossible.
        PANEL_ORIGIN="$(just agent-webview-dev-ensure '{{agent_panel_dev_port}}' "http://127.0.0.1:$FEEDPORT")"
        # Checked rather than trusted, because that value travels by stdout: anything else in the
        # recipe that prints lands in it, and the host answers a malformed origin by refusing to
        # build its panel at all -- on the Mac AND on every attached phone. Caught here it is one
        # failed launch naming the culprit.
        case "$PANEL_ORIGIN" in
            https://*) ;;
            *) echo "ERROR: agent-webview-dev-ensure printed more than an origin: $PANEL_ORIGIN" >&2; exit 1 ;;
        esac
        export {{agent_panel_origin_var}}="$PANEL_ORIGIN"
    fi
    # The sidecar, same live-or-frozen axis as the panel and for the same reason. `bundled` runs
    # the compiled binary the app ships with, so a one-line change to the sidecar costs a rebuild,
    # a relaunch, and a re-attach of every surface; `live` runs the supervisor over the source
    # (agent-feed/sidecar/src/supervisor.ts), which owns the server as a child and replaces it when
    # the tree typechecks, so an edit is live seconds later with the host and every attached phone
    # left alone. It replaced `bun --watch`, which re-read on every write: a file saved halfway
    # through an edit threw during the reload and left the process alive with its port free, so
    # every stream the panel holds died at once and nothing noticed for a minute.
    #
    # `live` is the default, the same as the panel, so the two halves of the panel surface behave
    # alike: an edit anywhere in it is live without a relaunch. The cost is real and is accepted --
    # this arm executes the WORKING TREE, so a half-saved file is what runs, and a run that must
    # judge the artifact as it ships has to say so. Arguments are POSITIONAL in just, so that is
    # `just host-run stable live bundled`, not `sidecar=bundled` (which would land in `variant`).
    case '{{sidecar}}' in
        live|bundled) ;;
        *) echo "ERROR: sidecar must be 'live' or 'bundled', got '{{sidecar}}'" >&2; exit 64 ;;
    esac
    if [ '{{sidecar}}' = live ]; then
        # Resolved to an absolute path here rather than searched for in the host, whose child
        # environment is deliberately stripped of the PATH that would find a Homebrew install.
        BUN_PATH="$(command -v bun || true)"
        if [ -z "$BUN_PATH" ]; then
            echo "ERROR: sidecar=live needs bun on PATH" >&2
            exit 1
        fi
        export AGENTDESK_BUN_PATH="$BUN_PATH"
        export AGENTDESK_AGENT_FEED_SIDECAR_ENTRY='{{agent_feed_sidecar_dir}}/src/supervisor.ts'
        # Its dependencies are resolved from the source tree now, not baked into a binary, so the
        # tree has to have them. Without this the host spawns bun, bun cannot resolve an import,
        # and the failure arrives as a sidecar that never answers readiness.
        node '{{justfile_directory()}}/tools/build-system/ensure-js-dependencies.mjs' \
          agent-feed-sidecar '{{agent_feed_sidecar_dir}}' '{{justfile_directory()}}/.build/js-dependencies'
    fi
    just prepare-pty-runtime "{{variant}}"
    # SWIFT_COMPILATION_MODE=singlefile keeps -O while making the unit of compilation the FILE
    # rather than the module. Release defaults to wholemodule, which puts the whole 83k-line host
    # through one serial frontend job, so a three-line edit costs the same as a clean build and
    # nine of ten cores sit idle watching it. Timed on this tree, same one-file edit each way:
    # wholemodule ~300s, singlefile 26s. Debug is 18s, and is NOT the answer -- it drops to -Onone
    # across the whole host, and this is the launch you judge shipped behaviour on.
    #
    # The cost is losing cross-file inlining, which was worth protecting only while the crisp tile
    # codec's per-byte loop was live. It is not: `crispTextOverlayEnabled` defaults to false and
    # `OwnedTileCodec.extractTileWithHash` has one caller behind that switch.
    sh tools/xcodebuild-quiet.sh -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Release -derivedDataPath "$DD" SWIFT_COMPILATION_MODE="${AGENTDESK_HOST_SWIFT_COMPILATION_MODE:-singlefile}" MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" ${EXTRA[@]+"${EXTRA[@]}"} build
    node tools/build-system/install-runtime.mjs verify-host "$BUILT_APP" "$HOST_BID"
    just grid-encoder-install
    # Both build configurations publish to this variant's one installed app.
    HOST_PIDS="$(sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost")"
    [ -n "$HOST_PIDS" ] && kill_host_pids $HOST_PIDS
    # Backstop for a same-bundle-id host under a different runtime-root override.
    # It may hold this variant's signaling port. Port-scoped, so the
    # sibling variant on its own tier-derived port is untouched.
    SIGPORT="${AGENTDESK_SIGNALING_PORT:-$SIGPORT}"
    UDP_PORT_RECORDS="$(lsof -nP -iUDP:"$SIGPORT" -F pn 2>/dev/null || true)"
    PORT_PIDS="$(
        {
            lsof -nP -iTCP:"$SIGPORT" -sTCP:LISTEN -t 2>/dev/null || true
            printf '%s\n' "$UDP_PORT_RECORDS" |
                sh tools/local-udp-port-pids.sh "$SIGPORT"
        } | sort -u
    )"
    # A stranger on this port is still in our way, so it is reclaimed too, not
    # reported. Only a host goes through kill_host_pids, whose child sweep is
    # written for a host's process tree and would be over-broad for anyone else.
    if [ -n "$PORT_PIDS" ]; then
        HOST_PORT_PIDS=()
        STRANGER_PORT_PIDS=()
        for PID in $PORT_PIDS; do
            CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
            if [[ "$CMD" == *"/AgentDeskHost.app/Contents/MacOS/AgentDeskHost"* ]]; then
                HOST_PORT_PIDS+=("$PID")
            else
                echo "reclaiming signaling port $SIGPORT from pid=$PID cmd=${CMD:-<already exited>}" >&2
                STRANGER_PORT_PIDS+=("$PID")
            fi
        done
        [ "${#HOST_PORT_PIDS[@]}" -gt 0 ] && kill_host_pids "${HOST_PORT_PIDS[@]}"
        [ "${#STRANGER_PORT_PIDS[@]}" -gt 0 ] && kill -9 "${STRANGER_PORT_PIDS[@]}" 2>/dev/null || true
    fi
    sh tools/reclaim-port.sh "agent-feed sidecar" "$FEEDPORT"
    sh tools/reclaim-port.sh "voice sidecar" "$VOICEPORT"
    sh tools/reclaim-port.sh "voice server" "$VOICEBACKENDPORT"
    sleep 1
    node tools/build-system/install-runtime.mjs host "$BUILT_APP" "$APP" "$HOST_BID"
    trap 'env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_ITERATION_RUN=1 tools/launch-env.sh unset' EXIT
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_ITERATION_RUN=1 tools/launch-env.sh set
    # Capture the host's stdio. Without this a Swift trap message is discarded and a crash leaves
    # nothing behind but a timestamp, which is exactly what happened to the close-all-sessions crash.
    # Roll the outgoing launch aside rather than truncating it: the relaunch after a crash is the
    # moment its output matters most. Only the tail survives, which is where a trap prints.
    if [ -s '{{host_stdio}}' ]; then
        tail -c '{{host_stdio_keep_bytes}}' '{{host_stdio}}' > '{{host_stdio}}.prev' 2>/dev/null || true
    fi
    : > '{{host_stdio}}'
    if [ "${AGENTDESK_AX_AUTOMATION_PRESERVE_FOCUS:-0}" != "0" ]; then
        open -g --stdout '{{host_stdio}}' --stderr '{{host_stdio}}' "$APP"
    else
        open --stdout '{{host_stdio}}' --stderr '{{host_stdio}}' "$APP"
    fi
    HOST_PID=""
    for _ in $(seq 1 50); do
        HOST_PID="$(sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost" | head -1)"
        [ -n "$HOST_PID" ] && break
        sleep 0.1
    done
    env AGENTDESK_AUTO_APPROVE=1 AGENTDESK_DEV_ITERATION_RUN=1 tools/launch-env.sh unset
    trap - EXIT
    test -n "$HOST_PID" || {
        echo "ERROR: newly built host did not launch: $APP" >&2
        exit 1
    }
    echo "$HOST_PID $APP/Contents/MacOS/AgentDeskHost"
    # DOM bridge first-class: wire this variant's native-messaging manifest on every launch.
    just dom-bridge-reinstall {{variant}} || echo "WARN: dom-bridge wiring failed; browser mode will not mirror until 'just dom-bridge-reinstall {{variant}}' succeeds"

# Bring the dev loop up at login, without building anything.
#
# `host-run` is the iteration command: build, install, launch. This is the LAUNCH half alone, for
# the one caller that has no reason to build -- launchd, at login. Without it a reboot silently
# returns this machine to the SHIPPED configuration, because launchd starts the installed app with
# launchd's environment and that carries none of the dev variables. The host then serves the frozen
# sidecar and the bundled panel while the tree being edited reaches nothing at all.
#
# Measured 2026-09-10, which is why this exists: a reboot left the sidecar on a binary compiled
# before the workspace routes existed, so the IDE answered `404 not found` with no JSON, and the
# only record of the switch anywhere on the machine was one `reloadsOnEdit=false` line in a log
# file. A wrong configuration that announces itself is a bad morning; one that does not is a day.
#
# Builds are deliberately absent. A login that compiles is a login that can fail to produce a host
# at all, and the installed app is by definition the last one that built. Run `just host-run` to
# move the installed app forward; this only starts what is already there.
host-login:
    #!/usr/bin/env bash
    set -euo pipefail
    APP='{{host_app}}'
    if [ ! -d "$APP" ]; then
        echo "ERROR: no installed host at $APP. Run 'just host-run' once to install one." >&2
        exit 1
    fi
    # Whoever is already here wins. launchd starts this job once per login, but a person can run it
    # too, and `open` on a running app activates it rather than relaunching -- which would leave a
    # host started WITHOUT this environment looking like one started with it.
    RUNNING="$(sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost" | head -1)"
    if [ -n "$RUNNING" ]; then
        echo "host-login: already running (pid $RUNNING); leaving it alone" >&2
        exit 0
    fi
    FEEDPORT="${AGENTDESK_AGENT_FEED_PORT:-7682}"
    NAME="$(sh tools/tailnet-dns-name.sh)"
    PANEL_ORIGIN="https://$NAME:{{agent_panel_dev_port}}"
    # WAIT for the panel dev server rather than starting one. The `*.paneldev` agent owns it, and a
    # server started from inside THIS job would not survive it: launchd reaps a job's process group
    # when the job exits, so the detached Vite that `agent-webview-dev-ensure` leaves behind dies
    # with the recipe that started it. Measured 2026-09-10 -- the log said "serving at" and the port
    # was empty seconds later.
    #
    # Both jobs are started by the same login, in no defined order, so this waits instead of
    # assuming. Sixty seconds covers a cold start that has to mint a certificate.
    serving() { curl -fs -o /dev/null --max-time 4 "$PANEL_ORIGIN/@vite/client"; }
    for _ in $(seq 1 60); do serving && break; sleep 1; done
    if ! serving; then
        # No panel agent installed, or it cannot come up. Start one the hand-run way and say so,
        # because from here on this server dies with this recipe.
        echo "host-login: nothing serving $PANEL_ORIGIN after 60s; starting one that will not outlive this job" >&2
        PANEL_ORIGIN="$(just agent-webview-dev-ensure '{{agent_panel_dev_port}}' "http://127.0.0.1:$FEEDPORT")"
        case "$PANEL_ORIGIN" in
            https://*) ;;
            *) echo "ERROR: agent-webview-dev-ensure printed more than an origin: $PANEL_ORIGIN" >&2; exit 1 ;;
        esac
    fi
    BUN_PATH="$(command -v bun || true)"
    if [ -z "$BUN_PATH" ]; then
        echo "ERROR: the live sidecar needs bun on PATH" >&2
        exit 1
    fi
    # The live sidecar resolves its dependencies from the source tree rather than from a compiled
    # binary, so the tree has to have them before the host spawns bun against it.
    node '{{justfile_directory()}}/tools/build-system/ensure-js-dependencies.mjs' \
      agent-feed-sidecar '{{agent_feed_sidecar_dir}}' '{{justfile_directory()}}/.build/js-dependencies' >&2
    # A sidecar outlives the host that spawned it whenever that host was killed rather than asked to
    # quit, and it keeps the port. The new host then starts its own, which cannot bind, and the
    # machine serves the DEAD host's sidecar -- which is how a live sidecar and a 404 coexist.
    # Measured while building this recipe: an orphaned bundled sidecar held 7682 while `bun --watch`
    # ran alongside it, and `/api/workspace/list` answered 404 with both of them up.
    sh tools/reclaim-port.sh "agent-feed sidecar" "$FEEDPORT"
    sh tools/reclaim-port.sh "voice sidecar" "${AGENTDESK_VOICE_SIDECAR_PORT:-7692}"
    if [ -s '{{host_stdio}}' ]; then
        tail -c '{{host_stdio_keep_bytes}}' '{{host_stdio}}' > '{{host_stdio}}.prev' 2>/dev/null || true
    fi
    : > '{{host_stdio}}'
    # `open --env` hands these to this app alone. `launch-env.sh` is the other way and is wrong here:
    # it goes through `launchctl setenv`, which publishes every value to every process that starts
    # on this Mac for as long as it is set, and a login job has no natural moment to unset them.
    #
    # AGENTDESK_DEV_ITERATION_RUN is load-bearing rather than cosmetic. It stops the host
    # registering its OWN LaunchAgent, which has no environment in it -- so a host started here can
    # never install the thing that would start an env-less copy at the next login.
    #
    # AGENTDESK_AUTO_APPROVE is deliberately NOT set. `host-run` sets it because a person is sitting
    # there watching the launch they just asked for; nothing is watching this one, and a pairing
    # request that approves itself while the Mac is unattended is a different thing entirely.
    open --stdout '{{host_stdio}}' --stderr '{{host_stdio}}' \
      --env "AGENTDESK_DEV_ITERATION_RUN=1" \
      --env "AGENTDESK_AGENT_PANEL_ORIGIN=$PANEL_ORIGIN" \
      --env "AGENTDESK_BUN_PATH=$BUN_PATH" \
      --env 'AGENTDESK_AGENT_FEED_SIDECAR_ENTRY={{agent_feed_sidecar_dir}}/src/supervisor.ts' \
      --env 'AGENTDESK_RUNTIME_ROOT={{runtime_root}}' \
      --env 'AGENT_FEED_GRID_ENCODER_PATH={{grid_encoder}}' \
      --env 'AGENT_FEED_PTY_MANAGER_SOCKET={{host_pty_manager_socket_path}}' \
      "$APP"
    HOST_PID=""
    for _ in $(seq 1 50); do
        HOST_PID="$(sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost" | head -1)"
        [ -n "$HOST_PID" ] && break
        sleep 0.1
    done
    test -n "$HOST_PID" || { echo "ERROR: installed host did not launch: $APP" >&2; exit 1; }
    echo "host-login: pid $HOST_PID panel $PANEL_ORIGIN sidecar live"

# Make the dev loop what this Mac comes back to after a restart.
#
# Four jobs: the host, the panel's dev server, a watcher per declared peer, and the relay a peer's
# sidecar reaches this Mac's proxy-agent through. What they have in common is that each is a piece
# of the no-rebuild loop that somebody would otherwise have to remember to start, and forgetting
# any of them leaves a machine that looks like it is working.
#
# Two LaunchAgents cannot both own the login launch, so this takes ownership from the app's own.
# `LaunchAgentInstaller` writes `{{host_bundle_id}}` with `RunAtLoad` and NO environment, which is
# right for a daily driver and is precisely the frozen configuration on a machine being developed
# on. It is booted out and removed here; the host will not write it again, because every launch
# this path makes carries AGENTDESK_DEV_ITERATION_RUN and that is the flag it checks.
#
# Reversible: `just dev-login-uninstall`, after which the next ordinary launch of the app restores
# its own agent and the machine is a daily driver again.
dev-login-install:
    #!/usr/bin/env bash
    set -euo pipefail
    AGENTS="$HOME/Library/LaunchAgents"
    LABEL='{{host_bundle_id}}.devlogin'
    PANEL_LABEL='{{host_bundle_id}}.paneldev'
    PEERS_LABEL='{{host_bundle_id}}.remotesidecars'
    RELAY_LABEL='{{host_bundle_id}}.proxyobserver'
    mkdir -p "$AGENTS"
    # The toolchain is located HERE, from a shell that has a working PATH, rather than guessed by
    # the script launchd runs. Every one of these lives somewhere a login job cannot find: `just`
    # under ~/.local/bin, `node` inside an nvm version directory that moves on every upgrade, `bun`
    # in Homebrew, `tailscale` in /usr/local. Capturing the resolved directories means an upgrade
    # that moves one is a re-install of this agent rather than a login that half works.
    TOOL_DIRS=""
    for TOOL in just bun node tailscale; do
        TOOL_PATH="$(command -v "$TOOL" || true)"
        if [ -z "$TOOL_PATH" ]; then
            echo "ERROR: $TOOL is not on PATH, and the login launch needs it" >&2
            exit 1
        fi
        TOOL_DIRS="$TOOL_DIRS$(dirname "$TOOL_PATH"):"
    done
    LOGIN_PATH="${TOOL_DIRS}/usr/bin:/bin:/usr/sbin:/sbin"
    # write_agent <label> <script> <keep-alive> <log>
    write_agent() {
        AGENT_PLIST="$AGENTS/$1.plist"
        cat > "$AGENT_PLIST" <<PLISTEOF
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key><string>$1</string>
      <key>ProgramArguments</key>
      <array><string>{{justfile_directory()}}/tools/$2</string></array>
      <key>RunAtLoad</key><true/>
      <key>KeepAlive</key><$3/>
      <key>ProcessType</key><string>Interactive</string>
      <key>LimitLoadToSessionType</key><string>Aqua</string>
      <key>EnvironmentVariables</key>
      <dict><key>PATH</key><string>$LOGIN_PATH</string></dict>
      <key>StandardOutPath</key><string>$4</string>
      <key>StandardErrorPath</key><string>$4</string>
    </dict>
    </plist>
    PLISTEOF
        # The heredoc is indented to sit inside this recipe, so take that indent back off. Every
        # value written here is a label or an absolute path, so none of them starts with spaces of
        # its own -- and `plutil -lint` is the check that this stayed true.
        sed -i '' 's/^    //' "$AGENT_PLIST"
        plutil -lint "$AGENT_PLIST" >/dev/null
        launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
        # `bootout` RETURNS BEFORE THE JOB IS GONE. It asks launchd to tear the service down, and a
        # long-running one takes seconds to actually go; `bootstrap` against a service that still
        # exists fails with "Bootstrap failed: 5: Input/output error" and nothing else. Measured
        # 2026-09-13 installing three agents: the host's job, which had already exited, replaced
        # itself fine, and the panel's Vite server did not -- so the install died halfway with the
        # dev server booted out and no replacement, which is the worst of the three states.
        #
        # Polled rather than slept, because the wait is however long that job takes to die and any
        # fixed number is either too short on a busy machine or wasted on every install.
        WAITED=0
        while launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; do
            if [ "$WAITED" -ge 100 ]; then
                echo "ERROR: $1 would not boot out after 20s; nothing was replaced" >&2
                exit 1
            fi
            sleep 0.2
            WAITED=$((WAITED + 1))
        done
        launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"
    }
    # Hand the app's own login agent over rather than racing it. Ordering between two RunAtLoad jobs
    # is undefined, and the loser of that race is whichever host `open` then merely activates.
    launchctl bootout "gui/$(id -u)/{{host_bundle_id}}" 2>/dev/null || true
    rm -f "$AGENTS/{{host_bundle_id}}.plist"
    write_agent "$LABEL" dev-login.sh false '{{dev_login_log}}'
    # The panel dev server is a second job rather than a child of the first, because a child does
    # not outlive it. KeepAlive on this one alone: it is the only piece that is a long-running
    # server in its own right, and the panel cannot load at all without it.
    write_agent "$PANEL_LABEL" panel-dev-login.sh true '{{panel_dev_login_log}}'
    # And a third, for the same two reasons. Every peer declared in .env gets its sidecar kept
    # running and kept current from here, because the alternative is remembering to ship after
    # every edit and after every reboot -- which is not a thing anyone remembers. A peer that is
    # merely answering tells you nothing about WHICH code it is answering from, so "it looks fine"
    # is not the check that would have caught it.
    #
    # Harmless with no peers declared: `watch-all` says so and exits 0, and KeepAlive is what makes
    # that a quiet loop rather than a failure. Declaring the first peer in .env is what starts it,
    # after a `launchctl kickstart -k` or the next login.
    write_agent "$PEERS_LABEL" remote-sidecar-login.sh true '{{remote_sidecar_login_log}}'
    # And a fourth, which is the peers job's other half. A peer's sidecar is pointed at this Mac's
    # proxy-agent observer API to mirror Claude's live network traffic, and that API is reachable
    # only through this relay. Without it the peer finds nothing at its own loopback and shows no
    # mirror -- which is indistinguishable from a peer whose sessions are simply quiet, so nothing
    # reports it.
    #
    # Note what this publishes: captured Anthropic API traffic, prompts and responses included,
    # reaches the tailnet through the relay's `tailscale serve` front. WireGuard device identity is
    # the whole of the boundary. Running this at login is that decision made once rather than each
    # time somebody starts it by hand.
    write_agent "$RELAY_LABEL" proxy-observer-relay-login.sh true '{{proxy_observer_relay_login_log}}'
    echo "dev-login-install: $LABEL, $PANEL_LABEL, $PEERS_LABEL and $RELAY_LABEL own this Mac's login launch"
    echo "  host log:   {{dev_login_log}}"
    echo "  panel log:  {{panel_dev_login_log}}"
    echo "  peers log:  {{remote_sidecar_login_log}}"
    echo "  relay log:  {{proxy_observer_relay_login_log}}"

# Give the login launch back to the app's own agent.
dev-login-uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    for LABEL in '{{host_bundle_id}}.devlogin' '{{host_bundle_id}}.paneldev' '{{host_bundle_id}}.remotesidecars' '{{host_bundle_id}}.proxyobserver'; do
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
        echo "dev-login-uninstall: removed $LABEL"
    done
    echo "The next ordinary launch of the app reinstalls its own agent, and this Mac is a daily driver again."

restart-pty-runtime variant="stable": build-pty-runtime
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then
        SUPPORT='{{host_dev_support_dir}}'
    else
        SUPPORT='{{host_support_dir}}'
    fi
    MANAGER_SOCKET="$SUPPORT/pty-manager.sock"
    VAULT_SOCKET="$SUPPORT/pty-vault.sock"
    MANAGER_DIGEST="$(shasum -a 256 '{{pty_manager_out}}' | awk '{ print $1 }')"
    VAULT_DIGEST="$(shasum -a 256 '{{pty_vault_out}}' | awk '{ print $1 }')"
    OLD_VAULT_PIDS="$(ps -axo pid=,command= | awk -v socket="$VAULT_SOCKET" 'index($0, "pty-vault --socket") && index($0, socket) { print $1 }' | tr '\n' ' ')"
    OLD_MANAGER_PIDS="$(ps -axo pid=,command= | awk -v socket="$MANAGER_SOCKET" 'index($0, "pty-manager --socket") && index($0, socket) { print $1 }' | tr '\n' ' ')"
    wait_for_identity() {
        local identity="$1" digest="$2" label="$3" old_pids="$4" identity_pid
        for _ in $(seq 1 200); do
            if [ -f "$identity" ] && grep -Fq "\"digest\":\"$digest\"" "$identity"; then
                identity_pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$identity")"
                case " $old_pids " in
                    *" $identity_pid "*) ;;
                    *) [ -n "$identity_pid" ] && return 0 ;;
                esac
            fi
            sleep 0.025
        done
        echo "ERROR: $label candidate did not publish authority identity; old generation remains authoritative" >&2
        return 1
    }
    if [ ! -S "$VAULT_SOCKET" ] || [ ! -S "$MANAGER_SOCKET.handover" ]; then
        echo "ERROR: durable PTY runtime is not active; use 'just reset-pty-runtime {{variant}}' only if losing sessions is intentional" >&2
        exit 1
    fi
    nohup '{{pty_vault_out}}' --socket "$VAULT_SOCKET" --handover \
        --runtime-digest "$VAULT_DIGEST" >/dev/null 2>&1 &
    wait_for_identity "$VAULT_SOCKET.identity" "$VAULT_DIGEST" "pty-vault" "$OLD_VAULT_PIDS"
    nohup '{{pty_manager_out}}' --socket "$MANAGER_SOCKET" --handover \
        --runtime-digest "$MANAGER_DIGEST" >/dev/null 2>&1 &
    wait_for_identity "$MANAGER_SOCKET.identity" "$MANAGER_DIGEST" "pty-manager" "$OLD_MANAGER_PIDS"
    pgrep -lf "pty-vault --socket $VAULT_SOCKET" || true
    pgrep -lf "pty-manager --socket $MANAGER_SOCKET" || true

reset-pty-runtime variant="stable": build-pty-runtime
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{variant}}" = "dev" ]; then
        SUPPORT='{{host_dev_support_dir}}'
    else
        SUPPORT='{{host_support_dir}}'
    fi
    MANAGER_SOCKET="$SUPPORT/pty-manager.sock"
    VAULT_SOCKET="$SUPPORT/pty-vault.sock"
    PIDS="$(
        ps -axo pid=,command= | awk -v manager="$MANAGER_SOCKET" -v vault="$VAULT_SOCKET" \
            '(index($0, "pty-manager --socket") && index($0, manager)) || (index($0, "pty-vault --socket") && index($0, vault)) { print $1 }'
    )"
    if [ -n "$PIDS" ]; then
        kill $PIDS 2>/dev/null || true
        for _ in $(seq 1 40); do
            LIVE="$(ps -p $PIDS -o pid= 2>/dev/null || true)"
            [ -z "$LIVE" ] && break
            sleep 0.05
        done
        LIVE="$(ps -p $PIDS -o pid= 2>/dev/null || true)"
        [ -z "$LIVE" ] || kill -9 $LIVE 2>/dev/null || true
    fi
    rm -f "$MANAGER_SOCKET" "$MANAGER_SOCKET.handover" "$MANAGER_SOCKET.identity" \
        "$VAULT_SOCKET" "$VAULT_SOCKET.identity"
    echo "PTY runtime reset for {{variant}}; prior sessions are not recoverable; the next host launch starts a fresh runtime"

# The only handover test that is not talking to itself. Builds the PTY runtime from an older
# commit, gives it a live session, then lets the current binaries take over and asserts the child
# process is the same one afterwards (ADR-0080). Every other handover test builds both peers from
# one tree and therefore cannot catch a wire change. Pass a base ref to choose the version gap;
# the interesting ones are the commit before a protocol change.
pty-handover-cross-version base="HEAD~1":
    bash '{{justfile_directory()}}/tools/pty-handover-cross-version.sh' '{{justfile_directory()}}' '{{base}}'

pty-live-update-verify base="HEAD~1":
    #!/usr/bin/env bash
    set -euo pipefail
    cd '{{pty_manager_dir}}'
    cargo test --test manager_handover_tests sequential_live_update_gate_emits_session_evidence -- --exact --nocapture
    cargo test --lib pty_session::tests
    cargo test --test manager_handover_tests manager_handover_preserves_a_transferred_session_with_no_clients -- --exact
    cd '{{justfile_directory()}}'
    xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost \
        -derivedDataPath '{{derived_data}}' test CODE_SIGNING_ALLOWED=NO \
        -only-testing:AgentDeskHostTests/HostPtyRuntimeProcessTests >/dev/null
    # The same-version tests above cannot see a wire change; this one can.
    just pty-handover-cross-version '{{base}}'

# Build client Debug for the iPhone and install (does not launch).
# variant: "stable" (default) or "dev" (the experimental side-by-side install:
# bundle id {{client_dev_bundle_id}}, DEV icon, "AgentDesk Dev" name, separate
# build dir). The dev variant overrides the three identity build settings inline.
# Depends on build-agent-webview for the same reason host-run does: the client
# bundles AgentPanel's package resources, and without the Vite output the only
# bundled tree is the inert fixture. AgentPanel now refuses to serve that, so an
# install without this dependency ships an "Agent view unavailable" panel. The
# recipe is stamp-cached, so it is a no-op when the web source has not changed.
#
# The build targets `generic/platform=iOS`, not this Mac's paired iPhone, and that is
# deliberate. Naming a concrete device makes xcodebuild resolve and hold that destination
# before it starts, so the whole multi-minute compile depends on the phone staying reachable --
# and over Wi-Fi it does not. A phone that blinks once during the build kills a build that never
# needed it, reporting "Timed out waiting for all destinations" plus a stale note about
# "previously reported preparation errors" that reads like corrupted Xcode state and is not.
# Compiling an arm64 app needs no device at all. Only `devicectl install` below does, and that
# step takes seconds and is cheap to retry.
client-install variant="stable": build-agent-webview
    #!/usr/bin/env bash
    set -euo pipefail
    GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
    if [ "{{variant}}" = "dev" ]; then
        sh tools/xcodebuild-quiet.sh -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath '{{dev_derived_data}}' -destination 'generic/platform=iOS' AGENTDESK_GIT_SHA="$GIT_SHA" AGENTDESK_CLIENT_BUNDLE_ID='{{client_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev BUNDLE_DISPLAY_NAME='AgentDesk Dev' build
        xcrun devicectl device install app --device {{ios_device}} '{{client_dev_app}}'
    else
        sh tools/xcodebuild-quiet.sh -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath '{{derived_data}}' -destination 'generic/platform=iOS' AGENTDESK_GIT_SHA="$GIT_SHA" build
        xcrun devicectl device install app --device {{ios_device}} '{{client_app}}'
    fi

# Historical recipe name retained for callers. This now performs an in-place
# build + install/update so the existing app container and saved recordings
# survive. Use an explicit devicectl uninstall manually only when data loss is
# intentionally required for install-time metadata testing.
client-reinstall variant="stable":
    just client-install {{variant}}

# Release-configuration client build for the iPhone + install (stable only; the
# experimental dev side-by-side variant stays Debug). Device install uses the same
# automatic development signing as the Debug path, so no distribution provisioning
# is needed. Used by the fresh-install feel-test composite.
#
# Release costs a whole-module-optimization compile of the whole client, so reach for it when
# you are judging MOTION -- decode, render, scroll, gesture feel. For a correctness change that
# merely has to run on the phone, `just client-install` builds the same app in Debug and is
# much faster. Note the host's rule does not transfer: the host stays Release because a Debug
# `-Onone` build pegs a core in the crisp tile codec, which is a host-side codec problem and
# says nothing about the client.
#
# Builds `generic/platform=iOS` rather than the paired device, for the reason in client-install.
# The Release client for feel runs and device installs.
#
# SWIFT_COMPILATION_MODE=singlefile for the same reason `host-run` uses it: Release does not
# have to mean a slow build. It keeps -O and makes the unit of compilation the FILE rather than
# the module, so one edited file stops costing a whole-module rebuild. Measured here at 2m20s
# on the wholemodule default for a one-file change, which is the whole reason iterating on the
# device felt expensive. `client-archive-release` deliberately does NOT set it: what TestFlight
# ships should be optimized across the module, and that build happens once per release rather
# than once per idea.
client-install-release: build-agent-webview
    sh tools/xcodebuild-quiet.sh -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Release -derivedDataPath '{{derived_data}}' -destination 'generic/platform=iOS' SWIFT_COMPILATION_MODE="${AGENTDESK_CLIENT_SWIFT_COMPILATION_MODE:-singlefile}" AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build
    xcrun devicectl device install app --device {{ios_device}} '{{client_app_release}}'

# Historical recipe name retained for callers. Updates the stable Release app
# in place and preserves its app container.
client-reinstall-release:
    just client-install-release

# Trigger pairing without scanning the QR. Sends SIGUSR1 to the running host
# (which mints a fresh URL and writes it to {{last_pair_url_path}}), then
# launches the iPhone client with the URL as a CommandLine argument so
# SceneDelegate routes it via handleIncomingPairingURL. The user just runs
# this; no menubar click, no camera, no manual paste.
pair-iphone variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    # dev client pairs with the dev host, which writes its pair URL under its own
    # bundle-id Application Support tree; read that variant's path.
    # dev pairs with the dev host; it also enables the Chrome DOM mirror on the client
    # (ADR-0038), matching the dev host default set by host-run. devicectl apps get env
    # not argv, so the client reads AGENTDESK_DOM_MIRROR_ENABLED via the CHILD prefix.
    if [ "{{variant}}" = "dev" ]; then HOST_APP='{{host_dev_app}}'; BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else HOST_APP='{{host_app}}'; BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    # Nothing here selects the panel's code. The HOST states its dev origin to the phone on every
    # agent-lane attach, so the phone picks up a TSX edit with no client rebuild and no reinstall,
    # and gets told again after a close and reopen. That has to come over the wire rather than from
    # a launch env, because the install that must work is the one from TestFlight, which has no
    # environment at all (ADR-0096).
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "$PAIR_URL"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 "$HOST_PID"
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
    umask 077
    case "{{variant}}" in
      stable) HOST_APP='{{host_app}}'; REQUEST_PATH='{{client_debug_request_path}}'; RESULT_PATH='{{client_debug_result_path}}' ;;
      dev) HOST_APP='{{host_dev_app}}'; REQUEST_PATH='{{host_dev_client_debug_request_path}}'; RESULT_PATH='{{host_dev_client_debug_result_path}}' ;;
      *) echo "variant must be stable or dev"; exit 2 ;;
    esac
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    TS="$(date +%Y%m%d-%H%M%S)"
    OUT_DIR="${AGENTDESK_CLIENT_DIAGNOSTICS_OUTPUT:-/tmp/agentdesk-client-diagnostics-$TS}"
    REQUEST_ID="$(uuidgen | tr 'A-Z' 'a-z')"
    mkdir -p "$(dirname "$REQUEST_PATH")"
    rm -f "$REQUEST_PATH" "$RESULT_PATH"
    python3 -c 'import json,sys; json.dump({"version":1,"operation":"diagnostics","requestId":sys.argv[2],"outputDirectory":sys.argv[3],"includePreviousRuns":True,"maxDiagnosticsBytes":786432}, open(sys.argv[1], "w", encoding="utf-8"))' "$REQUEST_PATH" "$REQUEST_ID" "$OUT_DIR"
    kill -USR2 "$HOST_PID"
    i=0
    while [ ! -s "$RESULT_PATH" ] && [ $i -lt 400 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$RESULT_PATH" || { echo "host did not write diagnostics result"; exit 1; }
    python3 -c 'import json,sys; data=json.load(open(sys.argv[1], "r", encoding="utf-8")); print(json.dumps(data, indent=2, sort_keys=True)); sys.exit(0 if data.get("status") == "ok" else 1)' "$RESULT_PATH"
    echo "Diagnostics directory: $OUT_DIR"

# Pull the phoneme analyzer's durable stage log through the authenticated
# diagnostics channel. The active session works directly; the fallback reaches
# a foreground paired client over tailnet, including on mobile data. Because
# prior unclean runs are included, reopen the app after a crash or memory kill
# and run this command. The payload contains bounded stage metadata, never audio.
voice-phone-logs-pull variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    umask 077
    TS="$(date +%Y%m%d-%H%M%S)"
    OUT_DIR="${AGENTDESK_VOICE_PHONE_LOGS_OUTPUT:-/tmp/agentdesk-voice-phone-logs-$TS}"
    test ! -e "$OUT_DIR" || {
      echo "voice phone logs output already exists: $OUT_DIR" >&2
      exit 1
    }
    AGENTDESK_CLIENT_DIAGNOSTICS_OUTPUT="$OUT_DIR" just client-diagnostics {{variant}}
    /usr/bin/python3 tools/voice-phone-evidence-summary.py \
      --diagnostics-directory "$OUT_DIR" \
      | tee "$OUT_DIR/phone-analysis-summary.txt"
    echo "Voice phone logs directory: $OUT_DIR"

# Export the newest host-retained client checkpoint timeline, automatically
# cached durable diagnostics, and the matching bounded host unified-log window.
# This is host-only and never installs, launches, or contacts the iPhone.
host-client-telemetry variant="stable":
    tools/host-client-telemetry.sh {{variant}}

# Pull saved Voice analysis metadata directly from a physical iPhone app
# container. This path does not require the app to be foregrounded or connected
# to the host, copies crash-surviving analyzer stage logs, and deliberately
# excludes raw audio.caf recordings.
voice-phone-evidence-pull variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    umask 077
    case "{{variant}}" in
      stable) BID='{{client_bundle_id}}' ;;
      dev) BID='{{client_dev_bundle_id}}' ;;
      *) echo "variant must be stable or dev"; exit 2 ;;
    esac
    TS="$(date +%Y%m%d-%H%M%S)"
    OUT_DIR="${AGENTDESK_VOICE_PHONE_EVIDENCE_OUTPUT:-/tmp/agentdesk-voice-phone-evidence-$TS}"
    test ! -e "$OUT_DIR" || {
      echo "voice phone evidence output already exists: $OUT_DIR" >&2
      exit 1
    }
    mkdir -p "$OUT_DIR"
    INVENTORY="$OUT_DIR/device-files.json"
    SOURCE_ROOT='Library/Application Support/AgentDesk/VoiceAttempts'
    run_devicectl() {
      local attempt=1
      while true; do
        if "$@"; then
          return 0
        fi
        if [ "$attempt" -ge 2 ]; then
          return 1
        fi
        echo "devicectl tunnel interrupted; retrying once..." >&2
        attempt=$((attempt + 1))
        sleep 1
      done
    }
    run_devicectl xcrun devicectl device info files \
      --device {{ios_device}} \
      --domain-type appDataContainer \
      --domain-identifier "$BID" \
      --subdirectory "$SOURCE_ROOT" \
      --recurse \
      --timeout 120 \
      --json-output "$INVENTORY" \
      >/dev/null
    /usr/bin/python3 tools/voice-phone-evidence-summary.py \
      --inventory-copy-paths "$INVENTORY" \
      | while IFS= read -r relative; do
      destination="$OUT_DIR/$relative"
      mkdir -p "$(dirname "$destination")"
      run_devicectl xcrun devicectl device copy from \
        --device {{ios_device}} \
        --domain-type appDataContainer \
        --domain-identifier "$BID" \
        --source "$SOURCE_ROOT/$relative" \
        --destination "$destination" \
        --timeout 120 \
        >/dev/null
    done
    /usr/bin/python3 tools/voice-phone-evidence-summary.py \
      "$OUT_DIR" \
      --model-manifest .build/voice-assets/VoicePhoneModelManifest.json \
      | tee "$OUT_DIR/summary.txt"
    echo "Voice phone evidence directory: $OUT_DIR"

# Capture the foreground AgentDesk client window on demand. The iOS setting
# "Allow paired Mac screenshots" must be enabled. This uses an active session
# when available, then the authenticated foreground offer-port fallback.
client-screenshot variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    umask 077
    case "{{variant}}" in
      stable) HOST_APP='{{host_app}}'; REQUEST_PATH='{{client_debug_request_path}}'; RESULT_PATH='{{client_debug_result_path}}' ;;
      dev) HOST_APP='{{host_dev_app}}'; REQUEST_PATH='{{host_dev_client_debug_request_path}}'; RESULT_PATH='{{host_dev_client_debug_result_path}}' ;;
      *) echo "variant must be stable or dev"; exit 2 ;;
    esac
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    TS="$(date +%Y%m%d-%H%M%S)"
    OUT_DIR="${AGENTDESK_CLIENT_SCREENSHOT_OUTPUT:-/tmp/agentdesk-client-screenshot-$TS}"
    REQUEST_ID="$(uuidgen | tr 'A-Z' 'a-z')"
    mkdir -p "$(dirname "$REQUEST_PATH")"
    rm -f "$REQUEST_PATH" "$RESULT_PATH"
    python3 -c 'import json,sys; json.dump({"version":1,"operation":"screenshot","requestId":sys.argv[2],"outputDirectory":sys.argv[3],"maxScreenshotBytes":4194304,"maxPixelDimension":2048}, open(sys.argv[1], "w", encoding="utf-8"))' "$REQUEST_PATH" "$REQUEST_ID" "$OUT_DIR"
    kill -USR2 "$HOST_PID"
    i=0
    while [ ! -s "$RESULT_PATH" ] && [ $i -lt 400 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$RESULT_PATH" || { echo "host did not write screenshot result"; exit 1; }
    python3 -c 'import json,sys; data=json.load(open(sys.argv[1], "r", encoding="utf-8")); print(json.dumps(data, indent=2, sort_keys=True)); sys.exit(0 if data.get("status") == "ok" else 1)' "$RESULT_PATH"
    echo "Screenshot: $OUT_DIR/client.jpg"

# Collect both the foreground app screenshot and bounded durable diagnostics
# into one private /tmp directory using the same request identifier.
client-debug-bundle variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    umask 077
    case "{{variant}}" in
      stable) HOST_APP='{{host_app}}'; REQUEST_PATH='{{client_debug_request_path}}'; RESULT_PATH='{{client_debug_result_path}}' ;;
      dev) HOST_APP='{{host_dev_app}}'; REQUEST_PATH='{{host_dev_client_debug_request_path}}'; RESULT_PATH='{{host_dev_client_debug_result_path}}' ;;
      *) echo "variant must be stable or dev"; exit 2 ;;
    esac
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    TS="$(date +%Y%m%d-%H%M%S)"
    OUT_DIR="${AGENTDESK_CLIENT_DEBUG_OUTPUT:-/tmp/agentdesk-client-debug-$TS}"
    REQUEST_ID="$(uuidgen | tr 'A-Z' 'a-z')"
    mkdir -p "$(dirname "$REQUEST_PATH")"
    rm -f "$REQUEST_PATH" "$RESULT_PATH"
    python3 -c 'import json,sys; json.dump({"version":1,"operation":"debug-bundle","requestId":sys.argv[2],"outputDirectory":sys.argv[3],"includePreviousRuns":True,"maxDiagnosticsBytes":786432,"maxScreenshotBytes":4194304,"maxPixelDimension":2048}, open(sys.argv[1], "w", encoding="utf-8"))' "$REQUEST_PATH" "$REQUEST_ID" "$OUT_DIR"
    kill -USR2 "$HOST_PID"
    i=0
    while [ ! -s "$RESULT_PATH" ] && [ $i -lt 400 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$RESULT_PATH" || { echo "host did not write debug bundle result"; exit 1; }
    python3 -c 'import json,sys; data=json.load(open(sys.argv[1], "r", encoding="utf-8")); print(json.dumps(data, indent=2, sort_keys=True)); sys.exit(0 if data.get("status") == "ok" else 1)' "$RESULT_PATH"
    echo "Debug bundle: $OUT_DIR"

# Pair-launch the physical iPhone client with the console attached. Blocks until
# the app exits and tees stdout/stderr to {{iphone_console_log}}. Owned-media stderr
# tracing is enabled so packet-repair diagnostics have a path separate from iOS
# unified logging. variant: stable (default) | dev.
iphone-console-run variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    # dev also enables the Chrome DOM mirror on the client (ADR-0038), matching the dev
    # host default; devicectl apps get env not argv, so it rides the CHILD prefix.
    if [ "{{variant}}" = "dev" ]; then HOST_APP='{{host_dev_app}}'; BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else HOST_APP='{{host_app}}'; BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    # Nothing here selects the panel's code; the host states its dev origin over the agent lane on
    # every attach, so a TSX edit reaches the phone with no client rebuild and survives a close and
    # reopen. See pair-iphone and ADR-0096.
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "$PAIR_URL" "{{iphone_console_log}}"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 "$HOST_PID"
    i=0; while [ ! -s "$PAIR_URL" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "$PAIR_URL" || { echo "host did not write pairing URL"; exit 1; }
    echo "URL: <redacted; delivered to client>"
    URL="$(cat "$PAIR_URL")"; VIDEO="${AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED:-1}"; env DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1" DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED="$VIDEO" ${DOM_ENV[@]+"${DOM_ENV[@]}"} xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing "$BID" 2>&1 | tee "{{iphone_console_log}}"

# R130 physical acceptance path. Updates the Release client in place and launches it
# with an attached console without starting, pairing, or waiting for the host.
# The first-run Voice entry is intentionally the surface under test.
voice-phone-device-run: voice-phone-model-check
    #!/usr/bin/env bash
    set -euo pipefail
    just client-install-release
    rm -f "{{iphone_console_log}}"
    xcrun devicectl device process launch \
        --device {{ios_device}} \
        --console \
        --terminate-existing \
        '{{client_bundle_id}}' 2>&1 | tee "{{iphone_console_log}}"

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
# bridge. The fresh sim composites call this
# so a stale manifest (e.g. pointing at the other variant's host socket from a previous
# run) never lingers. variant: dev (default) | stable; channel: chrome (default).
dom-bridge-reinstall variant="dev" channel="chrome":
    -just dom-bridge-uninstall {{channel}}
    just dom-bridge-install {{variant}} {{channel}}

# Clean DOM-mirror simulator run for the LATEST code (dev stack, non-blocking). One command to get
# the whole Chrome-mirror chain up on the sim:
#   1. host-run-dev dev        -- kill + rebuild + relaunch the DEV host with the DOM mirror +
#                             auto-approve + dev-iteration envs baked into the launched
#                             process (launch-env.sh set -> open -> unset; nothing lingers in launchd)
#   2. dom-bridge-reinstall dev -- (re)point the extension native-messaging manifest at the DEV
#                             host's socket, from clean, so a stale manifest never lingers
#   3. client-sim-install dev -- rebuild + update the DEV sim client in place
#   4. pair-sim dev        -- pair + launch the DEV sim client with the DOM mirror on
# Rebuilds host + client every run, so it always reflects the latest code. Leaves everything
# running and RETURNS (does not attach a console): then load/reload the extension in Chrome
# (chrome://extensions), start recording a tab from the popup, and drive the mirror on the sim.
# Runs the DEV stack only, so the stable daily-driver host/client are untouched. channel: the
# browser channel the bridge manifest targets (chrome default).
# Clean DEV DOM-mirror sim bring-up for the latest code (non-blocking): dev host + bridge + sim client + pair.
dom-mirror-sim channel="chrome":
    just host-run-dev dev
    just dom-bridge-reinstall dev {{channel}}
    just client-sim-install dev
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
    launchctl setenv AGENTDESK_DOM_MIRROR_ENABLED 1
    trap 'launchctl unsetenv AGENTDESK_DOM_MIRROR_ENABLED 2>/dev/null || true' EXIT
    just host-run
    just client-install-release
    HOST_PID="$(sh tools/exact-executable-pids.sh '{{host_app}}/Contents/MacOS/AgentDeskHost' | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running"; exit 1; }
    BID='{{client_bundle_id}}'
    rm -f "{{last_pair_url_path}}" "{{iphone_console_log}}"
    kill -USR1 "$HOST_PID"
    i=0; while [ ! -s "{{last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "{{last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    URL="$(cat "{{last_pair_url_path}}")"
    DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" \
      DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED="1" \
      DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1" \
      xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing "$BID" 2>&1 | tee "{{iphone_console_log}}"

# Dev-variant twin of dom-mirror-device-run. The dev client side-by-side install has no
# Release build path (client-install-release is stable-only), so this stays Debug on
# both host and client -- same shape as fresh-install-dev vs fresh-install. Runs against
# the AgentDesk Dev app/host, pairing URL under the dev host's own Application Support
# tree. Installs on / launches the PHYSICAL iPhone -- a STOP-and-wait checkpoint.
dom-mirror-device-run-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    launchctl setenv AGENTDESK_DOM_MIRROR_ENABLED 1
    trap 'launchctl unsetenv AGENTDESK_DOM_MIRROR_ENABLED 2>/dev/null || true' EXIT
    just host-run-dev dev
    just client-install dev
    HOST_PID="$(sh tools/exact-executable-pids.sh '{{host_dev_app}}/Contents/MacOS/AgentDeskHost' | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running"; exit 1; }
    BID='{{client_dev_bundle_id}}'
    rm -f "{{host_dev_last_pair_url_path}}" "{{iphone_console_log}}"
    kill -USR1 "$HOST_PID"
    i=0; while [ ! -s "{{host_dev_last_pair_url_path}}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    test -s "{{host_dev_last_pair_url_path}}" || { echo "host did not write pairing URL"; exit 1; }
    URL="$(cat "{{host_dev_last_pair_url_path}}")"
    DEVICECTL_CHILD_AGENTDESK_LAUNCH_URL="$URL" \
      DEVICECTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED="1" \
      DEVICECTL_CHILD_AGENTDESK_OWNED_MEDIA_STDERR_TRACE="1" \
      xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing "$BID" 2>&1 | tee "{{iphone_console_log}}"

# Physical-device feel/diagnostic runs. Two launch modes x two client variants. All
# rebuild and relaunch the host and update the client in place, preserving its app
# container. They differ in how the client is launched and in build configuration:
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
# The real bundled artifacts (Bun engine sidecar + Vite agent webview, and the
# gesture/voice webview + voice-server source) are built by host-run / host-run-dev
# itself now, so these composites no longer pre-build them -- the phone agent
# surface serves real projects/threads, not a build placeholder.
#
# BOTH legs pick panel code up live now, from one https origin on the tailnet (ADR-0096): the Mac
# host and the phone client each load the panel from the same Vite server, so a TSX edit reaches
# both with no rebuild, no reinstall, and no re-pair. The HOST decides this for both surfaces and
# states it to the phone on every attach, so the phone leg has no panel argument and a phone
# launched from the home screen or installed by TestFlight gets the live panel too, as long as it
# is paired to a host launched with one. The bundled webview these composites build and install is
# still what a phone falls back to when its host has none, so it still has to be current, which is
# why the build stays. These composites remain arg-free: to judge the shipped webview instead, run
# the host leg directly -- `just host-run stable bundled`, then pair as usual.
fresh-install:
    just host-run
    just client-install-release
    just pair-iphone stable

# Like fresh-install, but delivers the client over the air via TestFlight instead of a cabled USB
# install (the "wifi path"): builds the real agent-feed artifacts, rebuilds + relaunches the Release
# host so it is up and ready to pair, then uploads the client to TestFlight. Use when the iPhone is
# not connected by cable — the app arrives over wifi through TestFlight while the freshly launched
# host waits for menu-bar pairing. The upload archives into its own derived-data dir, so it does not
# disturb the host launched just above. Bump client_marketing_version first if this ships a change.
testflight-fresh:
    just host-run
    just testflight-upload stable

fresh-install-dev:
    just host-run-dev dev
    just client-install dev
    just pair-iphone dev

fresh-release-diagnostic-run:
    just host-run
    just client-install-release
    just iphone-console-run stable

fresh-diagnostic-run-dev:
    just host-run-dev dev
    just client-install dev
    just iphone-console-run dev

# One-shot, deterministic motion-carrier device verification (ADR-0025). Rebuilds
# the host and updates the client in place, launches both with the motion flag on, records
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
# One-shot motion-carrier device verification: rebuild host + update client, scroll, durable /tmp logs.
motion-verify variant="dev" video="1" seconds="60" fixed_profile="180,1,0.5":
    #!/usr/bin/env bash
    set -uo pipefail
    HOST_BIN='{{host_app}}/Contents/MacOS/AgentDeskHost'
    LOG_PID=""; CONSOLE_PID=""
    cleanup() {
        [ -n "$LOG_PID" ] && kill "$LOG_PID" 2>/dev/null || true
        [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null || true
        pkill -f "devicectl device process launch" 2>/dev/null || true
        rm -f "{{last_pair_url_path}}"
    }
    trap cleanup EXIT INT TERM

    : > "{{motion_host_oslog}}"; : > "{{motion_host_stdio}}"; : > "{{motion_client_log}}"
    if [ "{{variant}}" = "dev" ]; then BID='{{client_dev_bundle_id}}'; else BID='{{client_bundle_id}}'; fi
    IFS=',' read -r PROFILE_BITRATE PROFILE_FPS PROFILE_SCALE <<< "{{fixed_profile}}"
    PROFILE_SCALE_FORMATTED="$(printf '%.6f' "$PROFILE_SCALE")"
    PROFILE_LOG_MARKER="bitrateKbps=$PROFILE_BITRATE fps=$PROFILE_FPS resolutionScale=$PROFILE_SCALE_FORMATTED"

    echo "== [1/5] build host =="
    sh tools/xcodebuild-quiet.sh -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -configuration Debug -derivedDataPath '{{derived_data}}' PRODUCT_BUNDLE_IDENTIFIER='{{host_bundle_id}}' MARKETING_VERSION='{{host_marketing_version}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build

    echo "== [2/5] build + install client ($BID) =="
    just client-install {{variant}}

    echo "== [3/5] launch host (motion={{video}}), capture stdio + os_log =="
    # Clear a stale host and any leftover capture stream from a crashed prior run.
    HOST_PIDS="$(sh tools/exact-executable-pids.sh "$HOST_BIN")"
    [ -z "$HOST_PIDS" ] || kill $HOST_PIDS
    pkill -f 'log stream.*dev[.]dev[.]AgentDeskHost' 2>/dev/null || true
    sleep 1
    # Start the os_log capture BEFORE launch so the listener/server-started lines land.
    node tools/build-system/install-runtime.mjs host '{{host_build_app}}' '{{host_app}}' '{{host_bundle_id}}' || exit 1
    just grid-encoder-install || exit 1
    log stream --predicate 'subsystem == "com.example.agentdesk.AgentDeskHost"' --info --debug --style compact >"{{motion_host_oslog}}" 2>&1 &
    LOG_PID=$!
    sleep 1
    # `open --env` delivers config to the GUI app directly (no launchctl); --stdout/--stderr
    # capture its stdio. Forward EVERY AGENTDESK_* var from this recipe's environment
    # (.env via dotenv-load, plus the three defaults below), so the host sees the same
    # config the current code expects. Pass the resolved runtime/helper paths
    # explicitly because the helper override uses the AGENT_FEED_ namespace.
    export AGENTDESK_AUTO_APPROVE=1
    export AGENTDESK_DEV_ITERATION_RUN=1
    export AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED={{video}}
    HOST_ENV_ARGS=()
    while IFS= read -r kv; do HOST_ENV_ARGS+=( --env "$kv" ); done < <(env | grep '^AGENTDESK_')
    echo "forwarding $(env | grep -c '^AGENTDESK_') AGENTDESK_* vars to host"
    open --stdout "{{motion_host_stdio}}" --stderr "{{motion_host_stdio}}" "${HOST_ENV_ARGS[@]}" --env 'AGENTDESK_RUNTIME_ROOT={{runtime_root}}' --env 'AGENT_FEED_GRID_ENCODER_PATH={{grid_encoder}}' "{{host_app}}"
    HOST_PID=""; i=0
    while [ -z "$HOST_PID" ] && [ $i -lt 100 ]; do HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_BIN" | head -1)"; sleep 0.1; i=$((i+1)); done
    test -n "$HOST_PID" || { echo "host did not start"; exit 1; }
    # Wait until the host finishes launching before signaling it. SIGUSR1's default
    # disposition is terminate, so signaling before the host installs its handler kills
    # it. installAutomationSignalHandlers() runs early in applicationDidFinishLaunching,
    # well before "signaling server started" is logged, so that line is a safe gate.
    i=0; while ! grep -q "signaling server started" "{{motion_host_oslog}}" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    grep -q "signaling server started" "{{motion_host_oslog}}" 2>/dev/null || { echo "host did not finish launching"; exit 1; }
    echo "host pid=$HOST_PID  os_log-stream pid=$LOG_PID"

    echo "== [4/5] pair + attach client console ($BID) =="
    rm -f "{{last_pair_url_path}}"
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
    export DEVICECTL_CHILD_AGENTDESK_CLIENT_FIXED_MEDIA_PROFILE="{{fixed_profile}}"
    while IFS='=' read -r k v; do
        case "$k" in AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED|AGENTDESK_OWNED_MEDIA_STDERR_TRACE) continue;; esac
        export "DEVICECTL_CHILD_$k=$v"
    done < <(env | grep '^AGENTDESK_OWNED_MEDIA_')
    echo "client launch env: <redacted launch URL; fixed media profile={{fixed_profile}}>"
    xcrun devicectl device process launch --device {{ios_device}} --console --terminate-existing \
        "$BID" >"{{motion_client_log}}" 2>&1 &
    CONSOLE_PID=$!

    i=0
    while ! grep -q "$PROFILE_LOG_MARKER" "{{motion_host_oslog}}" 2>/dev/null && [ $i -lt 600 ]; do
        sleep 0.1
        i=$((i+1))
    done
    grep -q "$PROFILE_LOG_MARKER" "{{motion_host_oslog}}" 2>/dev/null || {
        echo "client did not connect and apply its fixed media profile"
        exit 1
    }

    echo "== [5/5] capturing connected session for {{seconds}}s -- SCROLL A WINDOW NOW =="
    sleep {{seconds}}

    AGENTDESK_CLIENT_DIAGNOSTICS_OUTPUT="{{motion_client_diagnostics}}" just client-diagnostics {{variant}}

    cleanup
    trap - EXIT INT TERM
    echo ""
    echo "== done. host left running (pid $HOST_PID). durable logs: =="
    echo "  host os_log : {{motion_host_oslog}}"
    echo "  host stdio  : {{motion_host_stdio}}"
    echo "  client      : {{motion_client_log}}"
    echo "  diagnostics : {{motion_client_diagnostics}}"

# Build client Debug for the iPhone simulator and install (does not launch).
# Mirrors `client-install` but targets the simulator instead of the
# physical device.
# variant: stable (default) | dev. The dev variant builds the dev-bundle-id client
# (DEV icon, separate derived-data) onto the dev simulator ({{ios_sim_udid_dev}}),
# so a full dev stack (dev host + dev client) runs beside the stable stack.
client-sim-install variant="stable": build-agent-webview
    #!/usr/bin/env bash
    set -euo pipefail
    GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
    if [ "{{variant}}" = "dev" ]; then
        SIM='{{ios_sim_udid_dev}}'; DD='{{dev_derived_data}}'; APP='{{client_sim_dev_app}}'
        EXTRA=(AGENTDESK_CLIENT_BUNDLE_ID='{{client_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev BUNDLE_DISPLAY_NAME='AgentDesk Dev')
    else
        SIM='{{ios_sim_udid}}'; DD='{{derived_data}}'; APP='{{client_sim_app}}'
        EXTRA=()
    fi
    xcrun simctl bootstatus "$SIM" -b >/dev/null
    sh tools/xcodebuild-quiet.sh -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Debug -derivedDataPath "$DD" -sdk iphonesimulator -destination "platform=iOS Simulator,id=$SIM" AGENTDESK_GIT_SHA="$GIT_SHA" ${EXTRA[@]+"${EXTRA[@]}"} build
    xcrun simctl install "$SIM" "$APP"

# Historical recipe name retained for callers. This now performs an in-place
# simulator build + install/update so app state survives. variant: stable
# (default) | dev.
client-sim-reinstall variant="stable":
    just client-sim-install {{variant}}

# Release-configuration twins of client-sim-install / the historical update alias, used by
# the sim-fresh-install feel-test composite. No signing concerns on the simulator.
client-sim-install-release: build-agent-webview
    xcrun simctl bootstatus {{ios_sim_udid}} -b >/dev/null
    sh tools/xcodebuild-quiet.sh -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -configuration Release -derivedDataPath '{{derived_data}}' -sdk iphonesimulator -destination 'platform=iOS Simulator,id={{ios_sim_udid}}' AGENTDESK_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" build
    xcrun simctl install {{ios_sim_udid}} "{{client_sim_app_release}}"

client-sim-reinstall-release:
    just client-sim-install-release

# Simulator equivalent of `pair-iphone`. RELAUNCH + RE-PAIR ONLY: this does
# NOT build or install -- it re-pairs and `simctl launch`es whatever client
# binary is ALREADY installed on the sim. To test a CODE change you must build
# + install first (client-sim-install), or use a full bring-up
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
    # dev sim pairs with the dev host, which mints its pair URL under its own
    # bundle-id Application Support tree; read that variant's path and sim.
    # dev sim pairs with the dev host and enables the Chrome DOM mirror on the client
    # (ADR-0038), matching the dev host default; simctl forwards it via the CHILD prefix.
    if [ "{{variant}}" = "dev" ]; then HOST_APP='{{host_dev_app}}'; SIM='{{ios_sim_udid_dev}}'; BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(SIMCTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else HOST_APP='{{host_app}}'; SIM='{{ios_sim_udid}}'; BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "$PAIR_URL"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 "$HOST_PID"
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
    if [ "{{variant}}" = "dev" ]; then HOST_APP='{{host_dev_app}}'; SIM='{{ios_sim_udid_dev}}'; BID='{{client_dev_bundle_id}}'; PAIR_URL='{{host_dev_last_pair_url_path}}'; DOM_ENV=(SIMCTL_CHILD_AGENTDESK_DOM_MIRROR_ENABLED=1); else HOST_APP='{{host_app}}'; SIM='{{ios_sim_udid}}'; BID='{{client_bundle_id}}'; PAIR_URL='{{last_pair_url_path}}'; DOM_ENV=(); fi
    HOST_PID="$(sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost" | head -1 || true)"
    test -n "$HOST_PID" || { echo "host not running; just host-run first"; exit 1; }
    rm -f "$PAIR_URL" "{{sim_console_log}}"
    trap 'rm -f "$PAIR_URL"' EXIT
    kill -USR1 "$HOST_PID"
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
# pair URL); only the client is rebuilt and updated in place.
# Update the simulator client and pair it to the already-running host (no host rebuild).
sim-reinstall-pair:
    just client-sim-install
    just pair-sim

# Rebuild and relaunch the Mac host and update the simulator app in place in
# Release (-configuration Release, host and client), then pair-launch with stdout/stderr
# attached (owned-media traces -> {{sim_console_log}}). This is the default simulator
# feel-test path; Release so it reflects shipped performance (a Debug -Onone host pegs a
# core in the crisp tile codec). Existing UserDefaults and saved app data survive; pairing
# is refreshed by the launch step. For a non-blocking paired launch (e.g. to drive a Maestro
# flow while the app stays open), run the Release leaves host-run, client-sim-install-release,
# pair-sim (or the Debug leaves host-run-dev, client-sim-install, pair-sim for fast iteration).
sim-fresh-install:
    just host-run
    just client-sim-install-release
    just dom-bridge-reinstall stable
    just sim-console-run

# DISTINCTION: agent-feed-sim BLOCKS with an attached console (use it to watch
# host/client traces live); agent-feed-sim-pair RETURNS (use it to then drive
# the app with `just ui-flow`). Both do a real build+install of host AND client;
# pair-sim does NOT (relaunch only). agent-feed-sim runs the DEBUG stack
# (host-run-dev); sim-fresh-install runs the RELEASE stack (host-run). Both now
# bundle the real artifacts, since host-run / host-run-dev build them first.
#
# Full agent-feed end-to-end simulator bring-up, blocking (attached console). It
# kills+rebuilds+relaunches the host (host-run-dev builds the real Bun sidecar +
# agent/gesture/voice webviews first), rebuilds+updates the client in place,
# pairs, and tails the client console to {{sim_console_log}}. Blocks. Use
# agent-feed-sim-pair for the non-blocking variant driven by Maestro (just
# ui-flow agent-feed-smoke).
agent-feed-sim:
    just host-run-dev
    just client-sim-install
    just dom-bridge-reinstall stable
    just sim-console-run

# Non-blocking twin of agent-feed-sim: rebuilds the host and updates the client in place
# (host-run-dev builds the real artifacts first), then does a non-blocking paired
# launch (pair-sim) so the app stays open for `just ui-flow <flow>` (e.g.
# agent-feed-smoke) to drive it and capture screenshots.
agent-feed-sim-pair:
    just host-run-dev
    just client-sim-install
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
    just host-run-dev dev
    just client-sim-install dev
    just dom-bridge-reinstall dev
    just sim-console-run dev

agent-feed-sim-pair-dev:
    just host-run-dev dev
    just client-sim-install dev
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
# `just ui-flow keyboard-up`. Pass `dev` as the second argument to target the
# isolated dev simulator and dev client bundle without touching the stable app.
#
# Requires brew-installed openjdk on PATH for JAVA_HOME.
ui-flow flow variant="stable":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{variant}}" in
        stable) SIM='{{ios_sim_udid}}'; BID='{{client_bundle_id}}' ;;
        dev) SIM='{{ios_sim_udid_dev}}'; BID='{{client_dev_bundle_id}}' ;;
        *) echo "unsupported simulator variant: {{variant}} (expected stable or dev)" >&2; exit 64 ;;
    esac
    FLOW='{{flow}}'
    FLOW_PATH="client/maestro/$FLOW.yaml"
    test -f "$FLOW_PATH" || { echo "Maestro flow not found: $FLOW_PATH" >&2; exit 66; }
    PROJECT_NAME="${AGENTDESK_MAESTRO_PROJECT_NAME:-}"
    CLAUDE_SESSION="${AGENTDESK_MAESTRO_CLAUDE_SESSION:-}"
    CODEX_SESSION="${AGENTDESK_MAESTRO_CODEX_SESSION:-}"
    if [ "$FLOW" = "agent-terminal-smoke" ]; then
        for selector in AGENTDESK_MAESTRO_PROJECT_NAME AGENTDESK_MAESTRO_CLAUDE_SESSION AGENTDESK_MAESTRO_CODEX_SESSION; do
            value="${!selector:-}"
            if [ -z "${value//[[:space:]]/}" ]; then
                echo "$selector is required for agent-terminal-smoke" >&2
                exit 64
            fi
        done
    fi
    mkdir -p client/maestro/screenshots
    cd client/maestro/screenshots
    JAVA_HOME="$(brew --prefix openjdk)/libexec/openjdk.jdk/Contents/Home" \
        maestro --udid "$SIM" test \
        -e "APP_ID=$BID" \
        -e "PROJECT_NAME=$PROJECT_NAME" \
        -e "CLAUDE_SESSION=$CLAUDE_SESSION" \
        -e "CODEX_SESSION=$CODEX_SESSION" \
        "../$FLOW.yaml"

# Stronger terminal simulator smoke: drives the shared web terminal, types a host
# command, screenshots the rendered PTY output, then OCR-checks the pixel buffer.
terminal-smoke:
    just agent-feed-sim-pair
    just ui-flow terminal-smoke
    swift tools/terminal-smoke-assert.swift client/maestro/screenshots/terminal-smoke.png AGDOK42

# Print the client build number used by TestFlight recipes. Defaults to the git
# commit count so each release build maps to the source revision being uploaded.
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
    # Archive into an isolated derived-data dir (NOT `derived_data`): the `clean archive` below wipes
    # its Build tree, so sharing it with a live host-run host would delete that host's on-disk
    # bundle mid-run and break its keychain/TCC identity (pairing then fails to sign the offer).
    if [ "{{variant}}" = "dev" ]; then
        ARCHIVE='{{client_dev_archive_path}}'; DD='{{client_dev_archive_derived_data}}'
        EXTRA=(AGENTDESK_CLIENT_BUNDLE_ID='{{client_dev_bundle_id}}' ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon.Dev BUNDLE_DISPLAY_NAME='AgentDesk Dev')
    else
        ARCHIVE='{{client_archive_path}}'; DD='{{client_archive_derived_data}}'
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
    # Raise embedded framework MinimumOSVersions to the app's target so App Store
    # validation (ITMS-90208) does not reject the bundle: the prebuilt onnxruntime
    # framework ships a 15.1 declared minimum while its binary and the app are 26.0.
    # The subsequent export re-signs the archive, baking the corrected plist in.
    tools/patch-embedded-minos.sh "$ARCHIVE"

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
