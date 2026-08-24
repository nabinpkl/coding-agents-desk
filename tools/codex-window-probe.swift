#!/usr/bin/env swift

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Codex Desktop composer probe: resolves a codex thread id to the window showing it and exercises
// the Accessibility fill path, read-only except for the explicit fill/submit commands. The
// mapping is Codex Desktop's own state (`~/.codex/state_5.sqlite` threads + `session_index.jsonl`)
// joined to each window's accessibility header (thread title button + `Project: <name>` popup),
// probed live on 2026-08-08: ChatGPT.app (bundle com.openai.codex) exposes full Chromium AX trees
// for every window on every Desktop WITHOUT any AXManualAccessibility latch, so fills are free.
//
// usage: codex-window-probe.swift <command> [options]
//
//   dump                          print every codex window's identity (title, project, frame)
//   resolve-thread <threadId>     resolve one thread to its window, or the refusal reason
//   fill <threadId> <text>        write the composer of the thread's window and read it back
//   submit <threadId> <text>      fill the composer and press Return, then read it back
//
// Env overrides: AGENTDESK_CODEX_MAIN_PATH (default /Applications/ChatGPT.app/Contents/MacOS/ChatGPT),
// AGENTDESK_CODEX_STATE_SQLITE (default ~/.codex/state_5.sqlite),
// AGENTDESK_CODEX_SESSION_INDEX (default ~/.codex/session_index.jsonl).

private let codexMainPath =
    ProcessInfo.processInfo.environment["AGENTDESK_CODEX_MAIN_PATH"]
    ?? "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"

private let home = FileManager.default.homeDirectoryForCurrentUser.path
private let sqlitePath = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_STATE_SQLITE"]
    ?? home + "/.codex/state_5.sqlite"
private let sessionIndexPath = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_SESSION_INDEX"]
    ?? home + "/.codex/session_index.jsonl"

private let composerDescription = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_COMPOSER_DESC"]
    ?? "Do anything"

private let headerChromeTitles: Set<String> = [
    "Back", "Forward", "Hide sidebar", "Show sidebar", "Search", "Open in",
    "Pull requests", "Sites", "Scheduled", "Plugins",
    "New chat", "Quick chat", "Add to chat", "More details", "Ask in side chat",
]

private let genericTitles: Set<String> = ["new chat", "new voice chat", "untitled", ""]

private enum DriverError: LocalizedError {
    case usage(String)
    case notResolved(String)
    case notRunning(String)
    case ax(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message): return message
        case .notResolved(let message): return message
        case .notRunning(let message): return message
        case .ax(let message): return message
        }
    }
}

// MARK: - AX helpers

private func axString(_ element: AXUIElement, _ attribute: String) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return "" }
    return value as? String ?? ""
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let children = value as? [AXUIElement] else { return [] }
    return children
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
    var rawPosition: CFTypeRef?
    var rawSize: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &rawPosition) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &rawSize) == .success,
          let position = rawPosition, let size = rawSize,
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    let axPosition = position as! AXValue
    let axSize = size as! AXValue
    var point = CGPoint.zero
    var sizeValue = CGSize.zero
    guard AXValueGetType(axPosition) == .cgPoint, AXValueGetType(axSize) == .cgSize,
          AXValueGetValue(axPosition, .cgPoint, &point), AXValueGetValue(axSize, .cgSize, &sizeValue)
    else { return nil }
    return CGRect(origin: point, size: sizeValue)
}

private func firstDescendant(
    in element: AXUIElement,
    depth: Int = 0,
    visited: inout Set<UInt>,
    matching: (AXUIElement) -> Bool
) -> AXUIElement? {
    guard depth < 48, visited.insert(CFHash(element)).inserted else { return nil }
    if matching(element) { return element }
    for child in axChildren(element) {
        if let found = firstDescendant(in: child, depth: depth + 1, visited: &visited, matching: matching) {
            return found
        }
    }
    return nil
}

/// Both spellings of the sidebar toggle: the label flips with the sidebar's state.
private let sidebarToggleLabels: Set<String> = ["Hide sidebar", "Show sidebar"]

/// A control's visible label. Codex Desktop labels text buttons through `AXTitle` and icon-only
/// chrome through `AXDescription`, and it moves controls between the two.
private func axLabel(_ element: AXUIElement) -> String {
    let title = axString(element, kAXTitleAttribute as String)
    return title.isEmpty ? axString(element, kAXDescriptionAttribute as String) : title
}

private func axParent(_ element: AXUIElement) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value) == .success,
          let parent = value, CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
    return parent as! AXUIElement
}

private func appElement(pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    return app
}

private func codexWindows(pid: pid_t) -> [AXUIElement] {
    let app = appElement(pid: pid)
    var found: [AXUIElement] = []
    var seen: Set<UInt> = []
    func add(_ element: AXUIElement) {
        if seen.insert(CFHash(element)).inserted { found.append(element) }
    }
    var raw: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
       let windows = raw as? [AXUIElement] {
        windows.forEach(add)
    }
    for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, attribute as CFString, &value) == .success,
              let window = value, CFGetTypeID(window) == AXUIElementGetTypeID() else { continue }
        add(window as! AXUIElement)
    }
    return found
}

/// The thread title button + project popup pair, the window's identity in the AX tree. The popup has
/// two live spellings (`Project: <name>` in the chat view, `Project actions for <name>` in the
/// sidebar); only a popup inside the header bar -- the group that also holds the `Hide sidebar`
/// button -- counts, which is what excludes the sidebar's per-project rows.
private func windowIdentity(_ window: AXUIElement) -> (title: String, project: String) {
    var visited: Set<UInt> = []
    guard let popup = firstDescendant(
        in: window,
        visited: &visited,
        matching: { element in
            guard axString(element, kAXRoleAttribute as String) == kAXPopUpButtonRole else { return false }
            let description = axString(element, kAXDescriptionAttribute as String)
            return description.hasPrefix("Project: ") || description.hasPrefix("Project actions for ")
        }
    ) else { return ("", "") }
    var header: AXUIElement? = popup
    var headerGroup: AXUIElement?
    for _ in 0..<8 {
        guard let current = header, let parent = axParent(current) else { break }
        header = parent
        var visitedHeader: Set<UInt> = []
        if firstDescendant(
            in: parent,
            visited: &visitedHeader,
            matching: { element in
                axString(element, kAXRoleAttribute as String) == kAXButtonRole
                    && sidebarToggleLabels.contains(axLabel(element))
            }
        ) != nil {
            headerGroup = parent
            break
        }
    }
    // The popup counts as identity ONLY inside the header bar; a window on the projects view has no
    // header bar and no open chat.
    guard let headerGroup else { return ("", "") }
    let description = axString(popup, kAXDescriptionAttribute as String)
    var project = ""
    if description.hasPrefix("Project: ") {
        project = String(description.dropFirst("Project: ".count))
    } else if description.hasPrefix("Project actions for ") {
        project = String(description.dropFirst("Project actions for ".count))
    }
    var visitedTitle: Set<UInt> = []
    let title = firstDescendant(
        in: headerGroup,
        visited: &visitedTitle,
        matching: { element in
            guard axString(element, kAXRoleAttribute as String) == kAXButtonRole else { return false }
            let title = axString(element, kAXTitleAttribute as String)
            return !title.isEmpty && !headerChromeTitles.contains(title)
        }
    ).map { axString($0, kAXTitleAttribute as String) } ?? ""
    return (title, project)
}

// MARK: - State files

private struct ThreadRecord {
    let threadId: String
    let title: String
    let cwd: String
}

private func threadRecord(_ threadId: String) -> ThreadRecord? {
    let literal = threadId.replacingOccurrences(of: "'", with: "''")
    let query = "SELECT id, title, cwd FROM threads WHERE id = '\(literal)' LIMIT 1;"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    process.arguments = ["-readonly", "-json", sqlitePath, query]
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()
    guard (try? process.run()) != nil else { return nil }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0, !data.isEmpty,
          let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
          let row = rows.first,
          let cwd = row["cwd"] as? String, !cwd.isEmpty else { return nil }
    return ThreadRecord(
        threadId: row["id"] as? String ?? threadId,
        title: row["title"] as? String ?? "",
        cwd: cwd
    )
}

private func threadName(_ threadId: String) -> String? {
    guard let text = try? String(contentsOfFile: sessionIndexPath, encoding: .utf8) else { return nil }
    for line in text.split(separator: "\n") {
        guard let data = line.data(using: .utf8),
              let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              entry["id"] as? String == threadId,
              let name = entry["thread_name"] as? String, !name.isEmpty else { continue }
        return name
    }
    return nil
}

private func projectName(for cwd: String) -> String {
    (cwd as NSString).lastPathComponent
}

// MARK: - Resolution

private func codexMainPid() -> pid_t? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axww", "-o", "pid=,args="]
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()
    guard (try? process.run()) != nil else { return nil }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    for line in text.split(separator: "\n") {
        let fields = line.split(separator: " ", omittingEmptySubsequences: true)
        guard fields.count >= 2 else { continue }
        let args = fields.dropFirst().joined(separator: " ")
        if args == codexMainPath || args.hasPrefix(codexMainPath + " ") {
            return pid_t(fields[0])
        }
    }
    return nil
}

private struct WindowSummary {
    let title: String
    let project: String
    let recentsFirstRow: String?
    let frame: CGRect
}

private func windowSummaries(pid: pid_t) -> [WindowSummary] {
    materializeTree(pid: pid)
    return codexWindows(pid: pid).compactMap { window in
        guard let frame = axFrame(window) else { return nil }
        let identity = windowIdentity(window)
        return WindowSummary(
            title: identity.title,
            project: identity.project,
            recentsFirstRow: recentsFirstRow(in: window),
            frame: frame
        )
    }
}

/// The title of the first row of the window's Recents list: the thread this window is showing. The
/// list lives in the `Recents` button's own group, so the per-project lists elsewhere in the sidebar
/// can never satisfy the anchor. Probed live: the first row follows the window's current thread.
private func recentsFirstRow(in window: AXUIElement) -> String? {
    var visited: Set<UInt> = []
    guard let recents = firstDescendant(
        in: window,
        visited: &visited,
        matching: { element in
            axString(element, kAXRoleAttribute as String) == kAXButtonRole
                && axLabel(element) == "Recents"
        }
    ), let listParent = axParent(recents) else { return nil }
    var listVisited: Set<UInt> = []
    guard let list = firstDescendant(
        in: listParent,
        visited: &listVisited,
        matching: { element in
            guard axString(element, kAXRoleAttribute as String) == kAXListRole else { return false }
            return firstRowTitle(of: element) != nil
        }
    ), let firstRow = firstRowTitle(of: list) else { return nil }
    return firstRow
}

private func firstRowTitle(of list: AXUIElement) -> String? {
    guard let firstRow = axChildren(list).first else { return nil }
    var visited: Set<UInt> = []
    return firstDescendant(
        in: firstRow,
        visited: &visited,
        matching: { element in
            let role = axString(element, kAXRoleAttribute as String)
            let title = axString(element, kAXTitleAttribute as String)
            return (role == kAXButtonRole || role == kAXStaticTextRole)
                && !title.isEmpty && !headerChromeTitles.contains(title)
        }
    ).map { axString($0, kAXTitleAttribute as String) }
}

/// The codex app builds its full Chromium tree lazily: with no AT client attached the web contents
/// collapse to bare shells, and a probe measured the full tree appearing within two seconds of an AX
/// client attaching. Attaching and waiting is the only materialization mechanism (the
/// `AXManualAccessibility` latch attribute is unsupported on this app).
private func materializeTree(pid: pid_t) {
    let app = appElement(pid: pid)
    if hasTextArea(in: app) { return }
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.25)
        if hasTextArea(in: app) { return }
    }
}

private func hasTextArea(in element: AXUIElement) -> Bool {
    var visited: Set<UInt> = []
    return firstDescendant(
        in: element,
        visited: &visited,
        matching: { axString($0, kAXRoleAttribute as String) == kAXTextAreaRole }
    ) != nil
}

private enum Resolution {
    case matched(WindowSummary)
    case ambiguous([WindowSummary])
    case notFound
}

private func resolve(_ threadId: String, pid: pid_t) -> Resolution {
    guard let record = threadRecord(threadId) else { return .notFound }
    let displayName = threadName(threadId) ?? record.title
    let isGeneric = genericTitles.contains(displayName.lowercased())
    let project = projectName(for: record.cwd)
    let windows = windowSummaries(pid: pid)
    let candidates = windows.filter { window in
        // Header-bar layout: title AND project together, or project alone for a generic title.
        if !window.project.isEmpty {
            guard window.project == project else { return false }
            if isGeneric { return true }
            return window.title == displayName || window.title.lowercased() == record.title.lowercased()
        }
        // Projects/Recents layout: the window's current thread is the first row of its Recents list.
        guard let firstRow = window.recentsFirstRow, !firstRow.isEmpty else { return false }
        return firstRow == displayName || firstRow.lowercased() == record.title.lowercased()
    }
    switch candidates.count {
    case 0: return .notFound
    case 1: return .matched(candidates[0])
    default: return .ambiguous(candidates)
    }
}

// MARK: - Composer

private func composerElement(frame: CGRect, pid: pid_t) throws -> AXUIElement {
    let windows = codexWindows(pid: pid)
    guard !windows.isEmpty else { throw DriverError.ax("no windows for pid \(pid)") }
    let matched = windows.count == 1 ? windows[0] : windows.first { window in
        guard let candidate = axFrame(window) else { return false }
        return abs(candidate.origin.x - frame.origin.x) < 2
            && abs(candidate.origin.y - frame.origin.y) < 2
            && abs(candidate.size.width - frame.size.width) < 2
            && abs(candidate.size.height - frame.size.height) < 2
    }
    guard let window = matched else { throw DriverError.ax("no AX window matches the resolved frame") }
    var visited: Set<UInt> = []
    guard let composer = firstDescendant(
        in: window,
        visited: &visited,
        matching: { element in
            axString(element, kAXRoleAttribute as String) == kAXTextAreaRole
                && axString(element, kAXDescriptionAttribute as String) == composerDescription
        }
    ) else { throw DriverError.ax("composer missing (AXTextArea described '\(composerDescription)')") }
    return composer
}

private func readComposer(frame: CGRect, pid: pid_t) throws -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(try composerElement(frame: frame, pid: pid), kAXValueAttribute as CFString, &value) == .success
    else { throw DriverError.ax("composer value read failed") }
    let text = value as? String ?? ""
    if text.isEmpty || text == "\n" + composerDescription { return "" }
    return text
}

private func writeComposer(_ text: String, frame: CGRect, pid: pid_t) throws -> String {
    let composer = try composerElement(frame: frame, pid: pid)
    guard AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString) == .success
    else { throw DriverError.ax("composer write failed") }
    // Settle: Chromium commits the value asynchronously; read until it matches.
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
        if let readBack = try? readComposer(frame: frame, pid: pid), canonical(readBack) == canonical(text) {
            return readBack
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return (try? readComposer(frame: frame, pid: pid)) ?? ""
}

private func submitComposer(text: String, frame: CGRect, pid: pid_t) throws -> String {
    let composer = try composerElement(frame: frame, pid: pid)
    guard AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    else { throw DriverError.ax("composer focus failed") }
    _ = try writeComposer(text, frame: frame, pid: pid)
    let returnKey: CGKeyCode = 36
    let source = CGEventSource(stateID: .hidSystemState)
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: true)
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: false)
    guard let keyDown, let keyUp else { throw DriverError.ax("return key synthesis failed") }
    keyDown.postToPid(pid)
    keyUp.postToPid(pid)
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
        let current = (try? readComposer(frame: frame, pid: pid)) ?? ""
        if current.isEmpty { return "" }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return (try? readComposer(frame: frame, pid: pid)) ?? ""
}

private func canonical(_ text: String) -> String {
    String(text.reversed().drop(while: \.isNewline).reversed())
}

// MARK: - Driver

private func requirePid() throws -> pid_t {
    guard let pid = codexMainPid() else {
        throw DriverError.notRunning("no running process for \(codexMainPath)")
    }
    return pid
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
        fputs("usage: codex-window-probe.swift dump | resolve-thread <id> | fill <id> <text> | submit <id> <text>\n", stderr)
        exit(64)
    }
    switch command {
    case "dump":
        let pid = try requirePid()
        for (index, window) in codexWindows(pid: pid).enumerated() {
            let identity = windowIdentity(window)
            let recents = recentsFirstRow(in: window) ?? ""
            let frame = axFrame(window).map(String.init(describing:)) ?? "nil"
            print("win[\(index)] title=\"\(identity.title)\" project=\"\(identity.project)\" recentsFirst=\"\(recents)\" frame=\(frame)")
        }

    case "resolve-thread":
        guard arguments.count >= 2 else { throw DriverError.usage("resolve-thread requires <threadId>") }
        let threadId = arguments[1]
        guard let record = threadRecord(threadId) else {
            print("thread=\(threadId) not-running (absent from \(sqlitePath))")
            break
        }
        print("thread=\(threadId)")
        print("  title=\(record.title) cwd=\(record.cwd)")
        print("  displayName=\(threadName(threadId) ?? "(none)")")
        let pid = try requirePid()
        switch resolve(threadId, pid: pid) {
        case .matched(let summary):
            print("  result: matched win at \(summary.frame)")
            print("  headerTitle=\"\(summary.title)\" project=\"\(summary.project)\" recentsFirst=\"\(summary.recentsFirstRow ?? "")\"")
        case .ambiguous(let candidates):
            print("  result: ambiguous across \(candidates.count) windows:")
            for candidate in candidates {
                print("    \(candidate.frame) title=\"\(candidate.title)\" project=\"\(candidate.project)\" recentsFirst=\"\(candidate.recentsFirstRow ?? "")\"")
            }
        case .notFound:
            print("  result: no open window shows this thread (or its header is unreadable)")
        }

    case "fill", "submit":
        guard arguments.count >= 3 else { throw DriverError.usage("\(command) requires <threadId> <text>") }
        let threadId = arguments[1]
        let text = arguments[2]
        let pid = try requirePid()
        switch resolve(threadId, pid: pid) {
        case .matched(let summary):
            let result = command == "fill"
                ? try writeComposer(text, frame: summary.frame, pid: pid)
                : try submitComposer(text: text, frame: summary.frame, pid: pid)
            print("\(command) -> readBack=\"\(result)\"")
        case .ambiguous:
            throw DriverError.notResolved("thread \(threadId) is ambiguous across open windows; refusing to write")
        case .notFound:
            throw DriverError.notResolved("thread \(threadId) matches no open window")
        }

    default:
        throw DriverError.usage("unknown command \(command)")
    }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(64)
}
