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
