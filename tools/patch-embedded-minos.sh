#!/usr/bin/env sh
# Bring every embedded framework's declared MinimumOSVersion up to the app's own
# minimum, never below it. Apple's App Store validation (ITMS-90208) rejects a
# bundle when an embedded framework's Info.plist MinimumOSVersion does not cover
# the deployment target the app and the framework binaries are built for. The
# prebuilt onnxruntime.xcframework ships a stale 15.1 in its framework
# Info.plist while its binary is built for the app's current target (26.0),
# which triggers exactly that rejection. Editing the archive before export is
# safe because `xcodebuild -exportArchive` re-signs every embedded code resource.
#
# usage: patch-embedded-minos.sh <xcarchive-path>
set -eu

archive="$1"
apps_dir="$archive/Products/Applications"
app_dir="$(find "$apps_dir" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n 1)"
if [ -z "$app_dir" ]; then
    printf 'no .app found under %s\n' "$apps_dir" >&2
    exit 1
fi

app_min="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$app_dir/Info.plist" 2>/dev/null || true)"
if [ -z "$app_min" ]; then
    printf 'no MinimumOSVersion in %s\n' "$app_dir/Info.plist" >&2
    exit 1
fi

# Exits 0 when the dotted version in $1 is strictly lower than the one in $2.
lt() {
    awk -v a="$1" -v b="$2" '
        BEGIN {
            na = split(a, A, "."); nb = split(b, B, ".");
            for (i = 1; i <= 3; i++) {
                ai = (i <= na ? A[i] + 0 : 0); bi = (i <= nb ? B[i] + 0 : 0);
                if (ai < bi) exit 0;
                if (ai > bi) exit 1;
            }
            exit 1;
        }'
}

changed=0
for framework in "$app_dir"/Frameworks/*.framework; do
    [ -d "$framework" ] || continue
    plist="$framework/Info.plist"
    [ -f "$plist" ] || continue
    current="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$plist" 2>/dev/null || true)"
    [ -n "$current" ] || continue
    if lt "$current" "$app_min"; then
        /usr/libexec/PlistBuddy -c "Set :MinimumOSVersion $app_min" "$plist"
        printf '%s: MinimumOSVersion %s -> %s\n' "$(basename "$framework")" "$current" "$app_min"
        changed=1
    fi
done

if [ "$changed" -eq 0 ]; then
    printf 'patch-embedded-minos: all embedded frameworks already support %s\n' "$app_min"
fi
