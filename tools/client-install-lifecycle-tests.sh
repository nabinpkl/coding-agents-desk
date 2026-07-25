#!/usr/bin/env sh
set -eu

assert_contains() {
    output="$1"
    expected="$2"
    description="$3"
    if ! printf '%s\n' "$output" | grep -Fq "$expected"; then
        printf 'client install lifecycle test failed: %s\nmissing: %s\n' \
            "$description" "$expected" >&2
        exit 1
    fi
}

assert_not_contains() {
    output="$1"
    rejected="$2"
    description="$3"
    if printf '%s\n' "$output" | grep -Fq "$rejected"; then
        printf 'client install lifecycle test failed: %s\nrejected: %s\n' \
            "$description" "$rejected" >&2
        exit 1
    fi
}

if grep -Eq \
    'devicectl device uninstall app|simctl uninstall' \
    Justfile; then
    printf '%s\n' \
        'client install lifecycle test failed: Justfile must not uninstall an iPhone app' \
        >&2
    exit 1
fi

physical_install="$(just --dry-run client-install stable 2>&1)"
assert_contains "$physical_install" \
    'devicectl device install app' \
    'physical install must update through devicectl install'

physical_update="$(just --dry-run client-reinstall stable 2>&1)"
assert_contains "$physical_update" \
    'just client-install stable' \
    'the historical physical reinstall recipe must delegate to update-in-place'
assert_not_contains "$physical_update" \
    'uninstall' \
    'the physical update recipe must preserve the app container'

physical_release_update="$(just --dry-run client-reinstall-release 2>&1)"
assert_contains "$physical_release_update" \
    'just client-install-release' \
    'the historical Release reinstall recipe must delegate to update-in-place'
assert_not_contains "$physical_release_update" \
    'uninstall' \
    'the Release update recipe must preserve the app container'

simulator_install="$(just --dry-run client-sim-install stable 2>&1)"
assert_contains "$simulator_install" \
    'simctl install' \
    'simulator install must update through simctl install'

simulator_update="$(just --dry-run client-sim-reinstall stable 2>&1)"
assert_contains "$simulator_update" \
    'just client-sim-install stable' \
    'the historical simulator reinstall recipe must delegate to update-in-place'
assert_not_contains "$simulator_update" \
    'uninstall' \
    'the simulator update recipe must preserve the app container'

simulator_release_update="$(just --dry-run client-sim-reinstall-release 2>&1)"
assert_contains "$simulator_release_update" \
    'just client-sim-install-release' \
    'the historical simulator Release reinstall recipe must delegate to update-in-place'
assert_not_contains "$simulator_release_update" \
    'uninstall' \
    'the simulator Release update recipe must preserve the app container'

printf 'client install lifecycle tests passed\n'
