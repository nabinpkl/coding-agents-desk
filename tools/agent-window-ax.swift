#!/usr/bin/env swift

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private enum DriverError: LocalizedError {
    case usage(String)
    case appNotRunning(String)
    case elementNotFound(String)
    case unsupportedKey(String)
    case actionFailed(String, AXError)
    case screenshotFailed(String)
    case permissionMissing(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message):
            return message
        case .appNotRunning(let bundleID):
            return "No running app found for bundle id \(bundleID)"
        case .elementNotFound(let description):
            return "No accessibility element matched \(description)"
        case .unsupportedKey(let name):
            return "Unsupported key name \(name)"
        case .actionFailed(let action, let error):
            return "Accessibility action \(action) failed with AXError \(error.rawValue)"
        case .screenshotFailed(let reason):
            return "Failed to capture screenshot: \(reason)"
        case .permissionMissing(let permission):
            return "Missing required macOS permission: \(permission)"
        }
    }
}

private enum Selector {
    case identifier(String)
    case domIdentifier(String)

    var description: String {
        switch self {
        case .identifier(let value): return "identifier \(value)"
        case .domIdentifier(let value): return "DOM identifier \(value)"
        }
    }
}

private struct CommonOptions {
    var bundleID = ProcessInfo.processInfo.environment["AGENTDESK_AX_BUNDLE_ID"]
        ?? "com.example.agentdesk.AgentDeskHost.dev"
    var windowIdentifier: String?
    var timeout: TimeInterval = 10
}

private struct Cursor {
    private let values: [String]
    private var index = 0

    init(_ values: [String]) {
        self.values = values
    }

    mutating func next() -> String? {
        guard index < values.count else { return nil }
        defer { index += 1 }
        return values[index]
    }

    mutating func requiredValue(after flag: String) throws -> String {
        guard let value = next() else {
            throw DriverError.usage("Missing value for \(flag)")
        }
        return value
    }
}

private func usage() -> String {
    """
    usage: agent-window-ax.swift <command> [options]

    commands:
      preflight
      dump [--bundle-id id] [--window-identifier id] [--depth n]
      wait --identifier id | --dom-identifier id [--bundle-id id] [--window-identifier id] [--timeout seconds]
      read --identifier id | --dom-identifier id [--bundle-id id] [--window-identifier id]
      press --identifier id | --dom-identifier id [--bundle-id id] [--window-identifier id]
      increment --identifier id [--count n] [--bundle-id id] [--window-identifier id]
      decrement --identifier id [--count n] [--bundle-id id] [--window-identifier id]
      type --text text [--bundle-id id]
      key --name keyname [--repeat n] [--bundle-id id]
      screenshot --output path [--bundle-id id] [--window-identifier id]

    supported keys: backspace, return, escape, tab, left, right, up, down
    """
}

private func axAttribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value as? T
}

private func axAttributeNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyAttributeNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

private func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axAttribute(element, kAXChildrenAttribute) ?? []
}

private func axChildrenInNavigationOrder(_ element: AXUIElement) -> [AXUIElement] {
    axAttribute(element, "AXChildrenInNavigationOrder") ?? []
}

private func axSingleElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    axAttribute(element, name)
}

private func axElements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    axAttribute(element, name) ?? []
}

private func axString(_ element: AXUIElement, _ name: String) -> String {
    axAttribute(element, name) ?? ""
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue: AXValue = axAttribute(element, kAXPositionAttribute),
          let sizeValue: AXValue = axAttribute(element, kAXSizeAttribute) else {
        return nil
    }

    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetType(positionValue) == .cgPoint,
          AXValueGetType(sizeValue) == .cgSize,
          AXValueGetValue(positionValue, .cgPoint, &point),
          AXValueGetValue(sizeValue, .cgSize, &size) else {
        return nil
    }
    return CGRect(origin: point, size: size)
}

private func runningApp(bundleID: String) throws -> NSRunningApplication {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
        throw DriverError.appNotRunning(bundleID)
    }
    return app
}

private func appElement(for app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 0.2)
    return element
}

private func windowElement(
    appElement: AXUIElement,
    identifier: String?
) throws -> AXUIElement? {
    guard let identifier else { return nil }
    let windows = relatedElements(for: appElement)
        .filter { axString($0, kAXRoleAttribute as String) == kAXWindowRole }
    if let match = windows.first(where: { axString($0, kAXIdentifierAttribute as String) == identifier }) {
        return match
    }
    throw DriverError.elementNotFound("window identifier \(identifier)")
}

private func matches(_ element: AXUIElement, selector: Selector) -> Bool {
    switch selector {
    case .identifier(let value):
        return axString(element, kAXIdentifierAttribute as String) == value
    case .domIdentifier(let value):
        return axString(element, kAXDOMIdentifierAttribute as String) == value
    }
}

private func relatedElements(for element: AXUIElement) -> [AXUIElement] {
    let role = axString(element, kAXRoleAttribute as String)
    var related: [AXUIElement] = []
    related.append(contentsOf: axChildren(element))
    related.append(contentsOf: axChildrenInNavigationOrder(element))

    if role == kAXApplicationRole {
        related.append(contentsOf: axElements(element, kAXWindowsAttribute as String))
        related.append(contentsOf: axElements(element, "AXFunctionRowTopLevelElements"))
        if let focusedWindow = axSingleElement(element, kAXFocusedWindowAttribute as String) {
            related.append(focusedWindow)
        }
        if let mainWindow = axSingleElement(element, kAXMainWindowAttribute as String) {
            related.append(mainWindow)
        }
        if let menuBar = axSingleElement(element, kAXMenuBarAttribute as String) {
            related.append(menuBar)
        }
        if let extrasMenuBar = axSingleElement(element, "AXExtrasMenuBar") {
            related.append(extrasMenuBar)
        }
        if let focusedElement = axSingleElement(element, kAXFocusedUIElementAttribute as String) {
            related.append(focusedElement)
        }
    }

    var seen: Set<UInt> = []
    var deduped: [AXUIElement] = []
    for relatedElement in related {
        let hash = CFHash(relatedElement)
        if seen.insert(hash).inserted {
            deduped.append(relatedElement)
        }
    }
    return deduped
}

private func findElement(
    in root: AXUIElement,
    selector: Selector,
    depth: Int = 0,
    visited: inout Set<UInt>
) -> AXUIElement? {
    let hash = CFHash(root)
    guard visited.insert(hash).inserted else { return nil }
    guard depth < 64 else { return nil }
    if matches(root, selector: selector) {
        return root
    }
    for child in relatedElements(for: root) {
        if let found = findElement(
            in: child,
            selector: selector,
            depth: depth + 1,
            visited: &visited
        ) {
            return found
        }
    }
    return nil
}

private func waitForElement(
    appElement: AXUIElement,
    selector: Selector,
    common: CommonOptions
) throws -> AXUIElement {
    let deadline = Date().addingTimeInterval(common.timeout)
    while Date() < deadline {
        let root = try windowElement(appElement: appElement, identifier: common.windowIdentifier) ?? appElement
        var visited: Set<UInt> = []
        if let element = findElement(in: root, selector: selector, visited: &visited) {
            return element
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    throw DriverError.elementNotFound(selector.description)
}

private func activateApp(_ app: NSRunningApplication, window: AXUIElement?) {
    _ = app.activate()
    if let window {
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}

private func selector(from cursor: inout Cursor) throws -> Selector {
    while let flag = cursor.next() {
        switch flag {
        case "--identifier":
            return .identifier(try cursor.requiredValue(after: flag))
        case "--dom-identifier":
            return .domIdentifier(try cursor.requiredValue(after: flag))
        default:
            throw DriverError.usage("Unknown selector flag \(flag)")
        }
    }
    throw DriverError.usage("Expected --identifier or --dom-identifier")
}

private func parseCommon(flag: String, cursor: inout Cursor, common: inout CommonOptions) throws -> Bool {
    switch flag {
    case "--bundle-id":
        common.bundleID = try cursor.requiredValue(after: flag)
        return true
    case "--window-identifier":
        common.windowIdentifier = try cursor.requiredValue(after: flag)
        return true
    case "--timeout":
        common.timeout = TimeInterval(try cursor.requiredValue(after: flag)) ?? common.timeout
        return true
    default:
        return false
    }
}

private func performPress(element: AXUIElement) throws {
    let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard error == .success else {
        throw DriverError.actionFailed("AXPress", error)
    }
}

private func performStep(element: AXUIElement, action: String, count: Int) throws {
    for _ in 0..<count {
        let error = AXUIElementPerformAction(element, action as CFString)
        guard error == .success else {
            throw DriverError.actionFailed(action, error)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
}

private func keyCode(for name: String) -> CGKeyCode? {
    switch name {
    case "backspace": return 51
    case "return": return 36
    case "escape": return 53
    case "tab": return 48
    case "left": return 123
    case "right": return 124
    case "down": return 125
    case "up": return 126
    default: return nil
    }
}

private func sendKey(_ keyCode: CGKeyCode, repeatCount: Int) {
    for _ in 0..<repeatCount {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
}

private func sendText(_ text: String) {
    for scalar in text.unicodeScalars {
        let string = String(scalar)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: string.utf16.count, unicodeString: Array(string.utf16))
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: string.utf16.count, unicodeString: Array(string.utf16))
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
}

private func screenshotWindow(
    app: NSRunningApplication,
    appElement: AXUIElement,
    windowIdentifier: String?,
    outputPath: String
) throws {
    guard let targetWindow = try windowElement(appElement: appElement, identifier: windowIdentifier) else {
        throw DriverError.elementNotFound("window identifier \(windowIdentifier ?? "nil")")
    }
    let title = axString(targetWindow, kAXTitleAttribute as String)
    let axBounds = axFrame(targetWindow)

    let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    let matches = raw.filter { entry in
        guard let ownerPID = entry[kCGWindowOwnerPID as String] as? pid_t,
              ownerPID == app.processIdentifier else {
            return false
        }
        let name = entry[kCGWindowName as String] as? String ?? ""
        guard name == title else { return false }
        if let axBounds,
           let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat] {
            let cgBounds = CGRect(
                x: bounds["X"] ?? 0,
                y: bounds["Y"] ?? 0,
                width: bounds["Width"] ?? 0,
                height: bounds["Height"] ?? 0
            )
            return abs(cgBounds.origin.x - axBounds.origin.x) < 2
                && abs(cgBounds.origin.y - axBounds.origin.y) < 2
                && abs(cgBounds.size.width - axBounds.size.width) < 2
                && abs(cgBounds.size.height - axBounds.size.height) < 2
        }
        return true
    }

    guard let windowID = matches.first?[kCGWindowNumber as String] as? CGWindowID else {
        throw DriverError.screenshotFailed("no matching on-screen window for \(title)")
    }
    let url = URL(fileURLWithPath: outputPath)
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-l", String(windowID), url.path]
    try capture.run()
    capture.waitUntilExit()
    guard capture.terminationStatus == 0 else {
        throw DriverError.screenshotFailed("screencapture exited with status \(capture.terminationStatus)")
    }
}

private func printElement(_ element: AXUIElement) {
    print("role=\(axString(element, kAXRoleAttribute as String))")
    print("identifier=\(axString(element, kAXIdentifierAttribute as String))")
    print("domIdentifier=\(axString(element, kAXDOMIdentifierAttribute as String))")
    print("title=\(axString(element, kAXTitleAttribute as String))")
    print("value=\(axString(element, kAXValueAttribute as String))")
    print("description=\(axString(element, kAXDescriptionAttribute as String))")
    print("actions=\(axActionNames(element).joined(separator: ","))")
    print("attributes=\(axAttributeNames(element).joined(separator: ","))")
}

private func dumpTree(_ element: AXUIElement, depth: Int, maxDepth: Int, visited: inout Set<UInt>) {
    let hash = CFHash(element)
    guard visited.insert(hash).inserted else { return }
    let prefix = String(repeating: "  ", count: depth)
    let role = axString(element, kAXRoleAttribute as String)
    let identifier = axString(element, kAXIdentifierAttribute as String)
    let domIdentifier = axString(element, kAXDOMIdentifierAttribute as String)
    let title = axString(element, kAXTitleAttribute as String)
    print("\(prefix)role=\(role) id=\(identifier) dom=\(domIdentifier) title=\(title)")
    guard depth < maxDepth else { return }
    for child in relatedElements(for: element) {
        dumpTree(child, depth: depth + 1, maxDepth: maxDepth, visited: &visited)
    }
}

do {
    var cursor = Cursor(Array(CommandLine.arguments.dropFirst()))
    guard let command = cursor.next() else {
        throw DriverError.usage(usage())
    }

    switch command {
    case "preflight":
        guard AXIsProcessTrusted() else {
            throw DriverError.permissionMissing("Accessibility for the AX driver process")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw DriverError.permissionMissing("Screen Recording for the AX driver process")
        }
        print("accessibility=trusted")
        print("screenRecording=trusted")

    case "dump":
        var common = CommonOptions()
        var maxDepth = 6
        while let flag = cursor.next() {
            if try parseCommon(flag: flag, cursor: &cursor, common: &common) { continue }
            switch flag {
            case "--depth":
                maxDepth = Int(try cursor.requiredValue(after: flag)) ?? maxDepth
            default:
                throw DriverError.usage("Unknown flag \(flag)")
            }
        }
        let app = try runningApp(bundleID: common.bundleID)
        let axApp = appElement(for: app)
        let root = try windowElement(appElement: axApp, identifier: common.windowIdentifier) ?? axApp
        var visited: Set<UInt> = []
        dumpTree(root, depth: 0, maxDepth: maxDepth, visited: &visited)

    case "wait", "read", "press", "increment", "decrement":
        var common = CommonOptions()
        var selector: Selector?
        var count = 1
        var remaining: [String] = []
        while let flag = cursor.next() {
            remaining.append(flag)
        }
        var selectorCursor = Cursor(remaining)
        while let flag = selectorCursor.next() {
            if try parseCommon(flag: flag, cursor: &selectorCursor, common: &common) { continue }
            switch flag {
            case "--identifier":
                selector = .identifier(try selectorCursor.requiredValue(after: flag))
            case "--dom-identifier":
                selector = .domIdentifier(try selectorCursor.requiredValue(after: flag))
            case "--count":
                count = Int(try selectorCursor.requiredValue(after: flag)) ?? count
            default:
                throw DriverError.usage("Unknown flag \(flag)")
            }
        }
        guard let selector else {
            throw DriverError.usage("Expected --identifier or --dom-identifier")
        }

        let app = try runningApp(bundleID: common.bundleID)
        let axApp = appElement(for: app)
        let window = try windowElement(appElement: axApp, identifier: common.windowIdentifier)
        let element = try waitForElement(appElement: axApp, selector: selector, common: common)

        switch command {
        case "wait":
            print(selector.description)
        case "read":
            printElement(element)
        case "press":
            activateApp(app, window: window)
            try performPress(element: element)
        case "increment":
            activateApp(app, window: window)
            try performStep(element: element, action: kAXIncrementAction, count: count)
        case "decrement":
            activateApp(app, window: window)
            try performStep(element: element, action: kAXDecrementAction, count: count)
        default:
            break
        }

    case "type":
        var common = CommonOptions()
        var text: String?
        while let flag = cursor.next() {
            if try parseCommon(flag: flag, cursor: &cursor, common: &common) { continue }
            switch flag {
            case "--text":
                text = try cursor.requiredValue(after: flag)
            default:
                throw DriverError.usage("Unknown flag \(flag)")
            }
        }
        guard let text else { throw DriverError.usage("Missing --text") }
        let app = try runningApp(bundleID: common.bundleID)
        activateApp(app, window: nil)
        sendText(text)

    case "key":
        var common = CommonOptions()
        var keyName: String?
        var repeatCount = 1
        while let flag = cursor.next() {
            if try parseCommon(flag: flag, cursor: &cursor, common: &common) { continue }
            switch flag {
            case "--name":
                keyName = try cursor.requiredValue(after: flag)
            case "--repeat":
                repeatCount = Int(try cursor.requiredValue(after: flag)) ?? repeatCount
            default:
                throw DriverError.usage("Unknown flag \(flag)")
            }
        }
        guard let keyName else { throw DriverError.usage("Missing --name") }
        guard let keyCode = keyCode(for: keyName) else {
            throw DriverError.unsupportedKey(keyName)
        }
        let app = try runningApp(bundleID: common.bundleID)
        activateApp(app, window: nil)
        sendKey(keyCode, repeatCount: repeatCount)

    case "screenshot":
        var common = CommonOptions()
        var outputPath: String?
        while let flag = cursor.next() {
            if try parseCommon(flag: flag, cursor: &cursor, common: &common) { continue }
            switch flag {
            case "--output":
                outputPath = try cursor.requiredValue(after: flag)
            default:
                throw DriverError.usage("Unknown flag \(flag)")
            }
        }
        guard let outputPath else { throw DriverError.usage("Missing --output") }
        let app = try runningApp(bundleID: common.bundleID)
        let axApp = appElement(for: app)
        activateApp(app, window: try windowElement(appElement: axApp, identifier: common.windowIdentifier))
        try screenshotWindow(
            app: app,
            appElement: axApp,
            windowIdentifier: common.windowIdentifier,
            outputPath: outputPath
        )
        print(outputPath)

    default:
        throw DriverError.usage(usage())
    }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(64)
}
