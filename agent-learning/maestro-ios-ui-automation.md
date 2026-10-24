---
name: maestro-ios-ui-automation
description: Use Maestro for declarative iOS UI automation on a simulator (Playwright equivalent for mobile). Covers the brew install path, the JAVA_HOME gotcha that makes the CLI hang silently, the --udid flag for targeting a specific booted simulator, where takeScreenshot writes, and the simctl env-var gotcha (SIMCTL_CHILD_ prefix) you only need if you fall back to hand-driving simctl.
metadata:
  type: reference
---

## When you are doing this

- You need to drive a running iOS app in a simulator to inspect a transient UI state (keyboard up, modal open, mid-animation, post-tap layout) without hacking a temporary env-gated trigger into the app code.
- You want a Playwright-equivalent for iOS: declarative, version-controlled flows that can tap, type, and screenshot.
- You want screenshots that you (or a CI) can diff later.

## The tool

[Maestro](https://maestro.dev) is the current standard for this. YAML flows, single binary, runs against a simulator UDID. The `--udid` flag pins the run to one device; without it, Maestro picks the first available which can be surprising on a machine with several booted sims.

## Install (macOS)

```bash
brew tap mobile-dev-inc/tap
brew install mobile-dev-inc/tap/maestro
```

Maestro is a JVM CLI. Brew pulls openjdk as a dep but **does not add it to PATH**. The CLI then hangs with `Unable to locate a Java Runtime. Please visit http://www.java.com for information on installing Java.` Set JAVA_HOME before invoking:

```bash
export JAVA_HOME="$(brew --prefix openjdk)/libexec/openjdk.jdk/Contents/Home"
```

Wire that into a `just` recipe so callers never see the hang. The agent-desk Justfile does this in the `ui-flow` recipe.

## Minimal flow

`client/maestro/keyboard-up.yaml`:

```yaml
appId: ${APP_ID}   # just ui-flow passes the client bundle id from .env
---
- launchApp:
    clearState: false
- waitForAnimationToEnd:
    timeout: 8000
- takeScreenshot: paired-idle
- tapOn:
    text: "Show keyboard"
- waitForAnimationToEnd:
    timeout: 3000
- takeScreenshot: keyboard-up
```

Run:

```bash
maestro --udid "$AGENTDESK_IOS_SIM_UDID" test client/maestro/keyboard-up.yaml
```

Or via the recipe:

```bash
just ui-flow keyboard-up
```

`clearState: false` keeps prior UserDefaults (pairing token, settings) so you do not have to re-pair before every flow. Switch to `true` when you specifically want a cold start, knowing you will lose pairing state.

## Where screenshots land

Maestro writes screenshots to the CWD where it was invoked, named `<screenshot-name>.png`. The `just ui-flow` recipe `cd`s into `client/maestro/screenshots/` before invoking so they pile up in a single gitignored folder, not at the repo root.

## tapOn selectors that work

- `tapOn: "Login"` — by visible text. Works against UIButton titles, UILabel text, etc.
- `tapOn: { id: "login-button" }` — by accessibilityIdentifier. Set via `view.accessibilityIdentifier = "..."` in Swift when text would be ambiguous or change.

Maestro's text matching is loose (substring, case-insensitive), so `tapOn: "Show keyboard"` will also match "Don't show keyboard". Use ids when ambiguity is real.

## simctl env-var gotcha (only if you fall back to hand-driving)

If you abandon Maestro and drive simctl directly, env vars are passed via caller-environment variables prefixed `SIMCTL_CHILD_`, not as positional arguments:

```bash
SIMCTL_CHILD_MY_FLAG=1 xcrun simctl launch --terminate-running-process <udid> com.example.app
```

Anything after the bundle id becomes `CommandLine.arguments`, not `ProcessInfo.processInfo.environment`. This is the same trap as devicectl (see `reference_ios_devicectl_url_delivery` in auto-memory).

## When NOT to use Maestro

- For tests that need to assert non-UI invariants (math, state, networking under failure). Use XCTest / Swift Testing for those.
- For tight unit-level loops. Maestro is end-to-end against a real simulator; per-flow startup is multi-second.

The right partitioning is: Swift Testing for logic, Maestro for "did the UI actually look right after this user journey".

## Real-world incident this came from

R12 keyboard sizing investigation in agent-desk. After fixing the missing UILaunchScreen (see [[ios-keyboard-oversized-from-missing-launch-screen]]), the soft keyboard rendered at native size but the local-echo text field collided with the trackpad's hint label and the scroll strip's chevron showed through behind it. Initial reflex was to add an env-gated `AGENTDESK_AUTOSHOW_KEYBOARD=1` trigger in `PairingViewController.startMediaTransportIfNeeded` to force the keyboard up on launch so I could screenshot. Wrong instinct: production code mutated to ease debugging. The right move was to install Maestro, write a 10-line YAML flow, and screenshot from outside the app. See commit landing this note for the Justfile recipe and the first flow.
