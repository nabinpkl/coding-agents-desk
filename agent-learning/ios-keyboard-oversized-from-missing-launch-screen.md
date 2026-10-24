---
name: ios-keyboard-oversized-from-missing-launch-screen
description: Trigger-pattern recognizer for the "iOS soft keyboard renders with abnormal key heights and letter spacing, looks zoomed" symptom in a custom iOS app. Real cause is the bundle shipping without UILaunchScreen or LaunchScreen.storyboard, which puts the app in legacy 320x480 compatibility scaling. Tunings on inputAccessoryView, UITextField traits, and TARGETED_DEVICE_FAMILY are all distractions because the system keyboard is being upscaled by the OS outside your view hierarchy.
metadata:
  type: feedback
---

## When you are doing this

- Building an iPhone app that summons the system soft keyboard from a UITextField (or any UIKeyInput first responder).
- App is hand-rolled, not from a Single View App template, or you trimmed a generated project and removed launch screen assets.
- Project may also be migrating from "1,2" to "1" TARGETED_DEVICE_FAMILY, which often happens around the same time and disguises the real cause.

## And you face this

- The QWERTY keys look obviously taller than the same iPhone's keyboard in Notes / Messages / Safari.
- Letter spacing inside the keyboard is too wide; the entire row feels stretched.
- Your custom `inputAccessoryView` sits at the size you specified, but the system keyboard underneath it is wrong.
- Live-tuning accessory container height, per-key height, and key spacing changes the accessory bar exactly as expected but does **nothing** to the alphabetic rows underneath.
- Flipping TARGETED_DEVICE_FAMILY from "1,2" to "1" does not help.
- Uninstall + reinstall (to flush iOS's per-bundle install-time metadata cache) does not help either.
- Info.plist looks clean. No `UIRequiresFullScreen=false`, no weird scene manifest, no iPad-only entries.

## What is actually wrong

The bundle has no launch screen declaration. Specifically, **all** of these are absent:

- No `LaunchScreen.storyboard` file in the project.
- No `UILaunchStoryboardName` in Info.plist.
- No `UILaunchScreen` dict in Info.plist (the iOS 13+ replacement).
- No `INFOPLIST_KEY_UILaunchScreen_Generation = YES` in build settings.

iOS treats a bundle with no launch screen as a legacy app. It renders the entire UI, **including the system soft keyboard process**, into a logical 320x480 window (iPhone 4 era), then upscales that frame buffer to fit the physical screen. The keyboard you see is not laid out for your device, it is laid out for a 320pt-wide screen and then scaled up by the OS compositor. Letter pitch and key height get the same scaling factor, hence the stretched look.

This is why nothing in your app changes it:
- Your `inputAccessoryView` is your view, you control its size; it renders at the resolution you set.
- The system keyboard alphabetic rows live in another process (`com.apple.UIKit.keyboard`), sized to the **window** size the OS reports for your app. Your bundle declares no support for modern screen sizes, so the OS reports 320pt and the keyboard process draws to that.

## Why the usual suspects mislead

- **TARGETED_DEVICE_FAMILY = "1,2"** is the right thing to suspect first if your iPad keyboard layout shows on an iPhone. But the symptom is different (split keyboard, floating, predictive bar layout, not key heights). Setting it to "1" is correct but does not fix scaling.
- **Custom UIView + UIKeyInput as first responder** does produce a wider-spaced keyboard than `UITextField` (the system uses a free-form layout for unknown first responders). Switching to `UITextField` fixes that variant. But if you switch and the keys are still oversized, the launch-screen cause is layered on top.
- **inputAccessoryView height / intrinsicContentSize** govern only your accessory bar. They are unrelated to the alphabetic rows below.
- **Reinstall** is needed for some install-time metadata flushes (it fixed the device-family cache for us), but the launch-screen flag is also install-time so you still need to reinstall after fixing it; the reinstall on its own is not the fix.

## The fix

Add to Info.plist:

```xml
<key>UILaunchScreen</key>
<dict/>
```

An empty dict is enough. This tells iOS "this bundle supports native screen sizes; do not run me in compatibility scaling." Build, then **full uninstall + reinstall** (just rebuilding will not flush iOS's cached scaling decision for the bundle id).

If you prefer the older storyboard approach, ship a `LaunchScreen.storyboard` and add `UILaunchStoryboardName` instead. The empty `UILaunchScreen` dict is simpler and avoids carrying a storyboard you do not otherwise use.

## Diagnosis checklist

When the symptom appears, walk through these in order:

1. Grep the project for any of: `UILaunchScreen`, `UILaunchStoryboardName`, `LaunchScreen.storyboard`, `INFOPLIST_KEY_UILaunchScreen_Generation`. If **none** are present, this is the bug. Add the empty `UILaunchScreen` dict and reinstall.
2. If a launch screen is present, check `TARGETED_DEVICE_FAMILY`. "1,2" on an iPhone-only app can produce iPad-style keyboard. Set to "1" and reinstall.
3. If both are fine, check that your first responder is a `UITextField` (or another standard input class), not a bare `UIView` conforming to `UIKeyInput`. The custom view path triggers iOS's fallback wide layout.
4. If all of those are clean, check `keyboardType`. `.asciiCapable` and `.default` give the standard QWERTY; some other values (`.numberPad`, `.URL`) give intentionally different layouts.

Step 1 is by far the most overlooked because everything in the Info.plist that **is** there looks correct, the bug is what is missing.

## Real-world incident this came from

R12 keyboard slice in agent-desk. The client was a from-scratch UIKit app with no Single View App template heritage, so it never had a launch screen. Days of work pivoted between:

- Wrong layout from UIView+UIKeyInput → switched to UITextField subclass.
- Device family suspected → flipped "1,2" to "1".
- Install-time cache suspected → added `just client-reinstall` recipe.
- Accessory bar over-redesigned → reverted and added live tunings sliders.

Tunings sliders proved the accessory bar reacted to settings while the alphabetic keys did not. That ruled out everything inside the view hierarchy and pointed at the system keyboard process being sized wrong. Grep for launch-screen artefacts came up empty, fix was one Info.plist line. See commit `b4c1e3e`.
