// The verb table for aiming input at one window, rather than at whatever holds focus.
//
// Everything else in this helper is deliberately non-obtrusive: `ComposerAccess` states at the top
// that it never raises, activates, or focuses, because the console user is working and a window
// that jumps to the front is a stolen keystroke. This file is the exception, and it is only
// defensible because of where it runs. The agent's login session has its own pointer, its own
// keyboard focus and its own active application, so raising a window there disturbs nobody. Calling
// this in a session someone is using would be the rude thing the rest of the file avoids.
//
// It composes rather than reimplements: `DesktopInputController` already owns the whole
// desktop-control vocabulary (keys, text, clicks, scrolls) with its bounds clamping and its
// trust checks, so a targeted send is "raise the window, then hand the same commands to the same
// parser", not a second implementation of typing that would drift from the first.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Commands one request may carry. Bounded for the same reason the key batch is: a request that
/// arrives malformed should be refused, not executed a thousand times.
private let maximumInputCommands = 64

func registerWindowInputVerbs(on control: ControlMode) {
    control.register("window-input") { request in
        guard AXIsProcessTrusted() else { return .failure("ax-denied") }
        guard let windowID = (request["windowID"] as? NSNumber)?.uint32Value, windowID != 0 else {
            return .failure("no-window")
        }
        guard let commands = request["input"] as? [[String: Any]],
              !commands.isEmpty,
              commands.count <= maximumInputCommands
        else {
            return .failure("write-failed")
        }
        guard let found = WindowInput.locate(windowID) else { return .failure("no-window") }

        // AppKit reads and AX actions on the main thread, matching `desktop-displays`: the command
        // reader runs on its own thread, and NSRunningApplication is not safe to touch from it.
        let raised = DispatchQueue.main.sync { WindowInput.raise(found) }
        guard raised else { return .failure("move-failed") }

        // Bounded to the window, so a pointer command inside this request cannot walk out of the
        // window it was aimed at and click something else.
        var receipts: [String] = []
        let controller = DesktopInputController(
            bounds: found.frame,
            emit: { data in
                if let text = String(data: data, encoding: .utf8) { receipts.append(text) }
            },
            // The session tap, never the HID tap. HID events go to whichever session holds the
            // console, so this helper running off-console would drive the console user's desktop
            // instead of its own. Same choice, same reason, as the capture path in `main.swift`.
            eventPoster: { $0.post(tap: .cgSessionEventTap) }
        )
        for command in commands {
            guard let data = try? JSONSerialization.data(withJSONObject: command),
                  let line = String(data: data, encoding: .utf8)
            else {
                return .failure("write-failed")
            }
            controller.handle(line)
        }
        // A held button would outlive the request and turn the next click into a drag.
        controller.releaseHeldButton()
        return .ok([
            "windowID": Int(windowID),
            "pid": Int(found.pid),
            "frame": [
                "x": found.frame.origin.x, "y": found.frame.origin.y,
                "w": found.frame.size.width, "h": found.frame.size.height,
            ],
            "delivered": commands.count,
            "receipts": receipts,
        ])
    }
}

enum WindowInput {
    struct Found {
        let pid: pid_t
        let frame: CGRect
        let element: AXUIElement
    }

    /// Resolves a WindowServer id to the AX element for the same window.
    ///
    /// Two lookups rather than one because neither side alone is enough: `CGWindowListCopyWindowInfo`
    /// knows the id and the owning process but exposes no AX handle, and the AX tree exposes handles
    /// but names windows by title, which is neither unique nor stable. `_AXUIElementGetWindow` is the
    /// bridge, and it is the same private call `CodexAccess` already relies on.
    static func locate(_ windowID: CGWindowID) -> Found? {
        let listed = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]]
        guard let entry = listed?.first,
              let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let raw = entry[kCGWindowBounds as String] as? [String: Any],
              let frame = CGRect(dictionaryRepresentation: raw as CFDictionary)
        else { return nil }

        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 2)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement]
        else { return nil }
        for window in windows {
            var found: CGWindowID = 0
            if _AXUIElementGetWindow(window, &found) == .success, found == windowID {
                return Found(pid: pid, frame: frame, element: window)
            }
        }
        return nil
    }

    /// Brings the window forward so posted events reach it.
    ///
    /// Both halves are needed and neither is sufficient. `kAXRaiseAction` orders the window within
    /// its own application; activating the application makes that application the one receiving key
    /// events at all. Raising without activating types into whatever app was already frontmost.
    static func raise(_ found: Found) -> Bool {
        let raised = AXUIElementPerformAction(found.element, kAXRaiseAction as CFString) == .success
        let activated = NSRunningApplication(processIdentifier: found.pid)?
            .activate(options: [.activateAllWindows]) ?? false
        return raised && activated
    }
}
