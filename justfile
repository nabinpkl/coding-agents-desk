# One named task surface. `just` lists recipes.

app := "build/DeskZoom.app"
sign_identity := env_var_or_default("DESKZOOM_SIGN_IDENTITY", "Apple Development: Owner Name (CERT000000)")

default:
    @just --list

# Compile the release binary.
build:
    swift build -c release

# Run unit tests.
test:
    swift test

# Build plus tests; the pre-commit bar.
check: build test

# Wrap the binary in an .app bundle and sign it with a stable identity so the
# Screen Recording grant survives rebuilds (TCC keys on signature + bundle id).
bundle: build
    rm -rf {{app}}
    mkdir -p {{app}}/Contents/MacOS
    cp .build/release/DeskZoom {{app}}/Contents/MacOS/DeskZoom
    cp Sources/DeskZoom/Info.plist {{app}}/Contents/Info.plist
    plutil -replace CFBundleVersion -string "$(git rev-parse --short HEAD 2>/dev/null || echo uncommitted)" {{app}}/Contents/Info.plist
    codesign --force --sign "{{sign_identity}}" {{app}}

# Build, bundle, and launch. Logs go to build/deskzoom.log.
dev: bundle
    pkill -x DeskZoom || true
    open {{app}} --stdout build/deskzoom.log --stderr build/deskzoom.log

# Launch with a custom virtual display size, e.g. `just dev-size 5120 3200`.
dev-size width height: bundle
    pkill -x DeskZoom || true
    open {{app}} --stdout build/deskzoom.log --stderr build/deskzoom.log --args --width {{width}} --height {{height}}

# Stop the running app (this also removes the virtual display).
stop:
    pkill -x DeskZoom || true

# Forget the Screen Recording grant if TCC gets confused after re-signing.
reset-tcc:
    tccutil reset ScreenCapture com.example.deskzoom

# --- The always-on virtual display ---------------------------------------------------------
#
# A virtual display belongs to the process that created it, so one started from a terminal
# lives exactly as long as that terminal's patience. launchd is the supervisor macOS already
# runs for this: `Aqua` puts the job in the console GUI session, where CoreGraphics will accept
# a display at all, and `KeepAlive` puts it back if it ever dies.

display_label := "com.example.deskzoom.display"
display_width := env_var_or_default("DESKZOOM_DISPLAY_WIDTH", "7680")
display_height := env_var_or_default("DESKZOOM_DISPLAY_HEIGHT", "4320")
display_plist := env_var("HOME") / "Library/LaunchAgents" / display_label + ".plist"
display_log := env_var("HOME") / "Library/Logs/DeskZoom/display.log"

# Install and start the LaunchAgent that holds the virtual display open across logins.
display-install: build
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "$(dirname '{{display_plist}}')" "$(dirname '{{display_log}}')"
    cat > '{{display_plist}}' <<'PLIST'
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key>
      <string>{{display_label}}</string>
      <key>ProgramArguments</key>
      <array>
        <string>{{justfile_directory()}}/.build/release/DeskZoom</string>
        <string>--display-only</string>
        <string>--width</string>
        <string>{{display_width}}</string>
        <string>--height</string>
        <string>{{display_height}}</string>
      </array>
      <key>RunAtLoad</key>
      <true/>
      <key>KeepAlive</key>
      <true/>
      <key>LimitLoadToSessionType</key>
      <string>Aqua</string>
      <key>ProcessType</key>
      <string>Interactive</string>
      <key>StandardOutPath</key>
      <string>{{display_log}}</string>
      <key>StandardErrorPath</key>
      <string>{{display_log}}</string>
    </dict>
    </plist>
    PLIST
    plutil -lint '{{display_plist}}'
    # Replace rather than reload: bootstrap on an already-loaded label is an error, and a plist
    # edited under a loaded job is not read until the job is booted out.
    launchctl bootout "gui/$UID/{{display_label}}" 2>/dev/null || true
    launchctl bootstrap "gui/$UID" '{{display_plist}}'
    echo "installed {{display_label}} ({{display_width}}x{{display_height}}); log: {{display_log}}"

# Stop the LaunchAgent and remove it. The display goes away with the process.
display-uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    launchctl bootout "gui/$UID/{{display_label}}" 2>/dev/null || true
    rm -f '{{display_plist}}'
    echo "removed {{display_label}}"

# What launchd thinks it is running, and what the window server actually has.
display-status:
    #!/usr/bin/env bash
    launchctl print "gui/$UID/{{display_label}}" 2>/dev/null \
      | grep -E '^\s+(state|pid|last exit code|program) ' || echo "{{display_label}} not loaded"
    {{justfile_directory()}}/.build/release/DeskZoom --list-displays
